import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyTitleSummaryPatch,
  cleanSummarizedTitle,
  countRealUserMessages,
  createSessionFirstGate,
  readTitleSummarySettings,
  scheduleSessionTitleSummary,
  shouldAutoSummarizeTitle,
  titleExcerptFromJsonl,
  titleSummaryRequest,
  titleSummarySeed,
  writeTitleSummarySettings,
} from "./session-title-summary.js";

test("cleanSummarizedTitle strips wrappers and keeps one short line", () => {
  assert.equal(cleanSummarizedTitle('"Debug WebSocket reconnection"'), "Debug WebSocket reconnection");
  assert.equal(cleanSummarizedTitle("“重构用户认证模块”"), "重构用户认证模块");
  assert.equal(cleanSummarizedTitle("标题：修复登录失败问题！"), "修复登录失败问题");
  assert.equal(cleanSummarizedTitle("<think>secret</think>\nFix login"), "Fix login");
  assert.equal(cleanSummarizedTitle('{"title":"Add export CSV"}'), "Add export CSV");
  assert.equal(cleanSummarizedTitle("..."), "");
  assert.equal(cleanSummarizedTitle("A".repeat(80)).length, 60);
});

test("manual title excerpt keeps the start and the latest user message", () => {
  const source = titleExcerptFromJsonl(
    [
      '{"type":"message","message":{"role":"user","content":"/plan"}}',
      '{"type":"message","message":{"role":"user","content":"先修登录"}}',
      '{"type":"model_change","provider":"lens","modelId":"glm"}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"看了认证"}],"provider":"lens","model":"glm"}}',
      '{"type":"message","message":{"role":"user","content":"再补测试"}}',
    ].join("\n"),
  );
  assert.deepEqual(source.userTexts, ["先修登录", "再补测试"]);
  assert.equal(source.assistantText, "看了认证");
  assert.equal(source.provider, "lens");
  assert.equal(source.model, "glm");
  const prompt = titleSummaryRequest(
    ["第一句", "第二句", "第三句", "最后一句"],
    "助手",
  );
  assert.match(prompt ?? "", /第一句/);
  assert.match(prompt ?? "", /第二句/);
  assert.match(prompt ?? "", /最后一句/);
  assert.doesNotMatch(prompt ?? "", /第三句/);
});

test("titleSummarySeed keeps the first real prompt and ignores commands", () => {
  const seed = titleSummarySeed([
    { kind: "userInput", origin: "realUser", text: "/plan" },
    { kind: "userInput", origin: "realUser", text: "修一下登录" },
    { kind: "assistantText", text: "先看认证" },
    { kind: "userInput", origin: "synthetic", text: "继续" },
  ]);
  assert.equal(seed?.realUserCount, 1);
  assert.equal(seed?.userPrompt, "修一下登录");
  assert.equal(seed?.assistantReply, "先看认证");
});

test("title summary settings default on and round-trip the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-title-"));
  assert.deepEqual(await readTitleSummarySettings(dir), { enabled: true });
  const next = applyTitleSummaryPatch(
    { enabled: true },
    { enabled: false, provider: "lens", model: "glm" },
  );
  await writeTitleSummarySettings(dir, next);
  assert.deepEqual(await readTitleSummarySettings(dir), {
    enabled: false,
    provider: "lens",
    model: "glm",
  });
  const cleared = applyTitleSummaryPatch(next, { provider: "", model: "" });
  await writeTitleSummarySettings(dir, cleared);
  const saved = await readFile(join(dir, "zcode-title-summary.json"), "utf8");
  assert.equal(saved.includes("provider"), false);
  assert.deepEqual(await readTitleSummarySettings(dir), { enabled: false });
});

test("auto title starts when the first user message lands", () => {
  assert.equal(
    shouldAutoSummarizeTitle({ type: "message_start", message: { role: "user" } }),
    true,
  );
  assert.equal(
    shouldAutoSummarizeTitle({ type: "message_start", message: { role: "assistant" } }),
    false,
  );
  assert.equal(shouldAutoSummarizeTitle({ type: "agent_end" }), true);
  assert.equal(shouldAutoSummarizeTitle({ type: "agent_end", willRetry: true }), false);
  assert.equal(shouldAutoSummarizeTitle({ type: "agent_settled" }), false);
});

test("an in-flight first-message summary is not replaced when a second message arrives", async () => {
  let committed = "";
  const base = {
    fallbackProvider: "lens",
    fallbackModel: "glm",
    readSettings: async () => ({ enabled: true }),
    stillEligible: () => true,
  };
  scheduleSessionTitleSummary({
    ...base,
    sessionId: "summary-early",
    rows: [{ kind: "userInput", origin: "realUser", text: "发送中途再发一条，会话结束了" }],
    complete: async (request) => {
      assert.match(request.prompt, /发送中途再发一条/);
      return "中断后的标题";
    },
    commit: (title) => {
      committed = title;
    },
  });
  scheduleSessionTitleSummary({
    ...base,
    sessionId: "summary-early",
    rows: [
      { kind: "userInput", origin: "realUser", text: "发送中途再发一条，会话结束了" },
      { kind: "userInput", origin: "realUser", text: "再发一条" },
    ],
    complete: async () => "不该用这条",
    commit: () => {
      committed = "overwritten";
    },
  });
  await waitFor(() => committed === "中断后的标题");
});

test("scheduleSessionTitleSummary uses the conversation model and does not repeat", async () => {
  const calls: string[] = [];
  let committed = "";
  scheduleSessionTitleSummary({
    sessionId: "summary-once",
    titleSource: "generated",
    rows: [
      { kind: "userInput", origin: "realUser", text: "帮我修登录失败" },
      { kind: "assistantText", text: "我先看认证模块" },
    ],
    fallbackProvider: "lens",
    fallbackModel: "glm",
    readSettings: async () => ({ enabled: true }),
    complete: async (request) => {
      calls.push(`${request.providerId}/${request.modelId}`);
      assert.match(request.prompt, /帮我修登录失败/);
      assert.match(request.prompt, /我先看认证模块/);
      return "修复登录失败";
    },
    stillEligible: () => true,
    commit: (title) => {
      committed = title;
    },
  });
  await waitFor(() => committed === "修复登录失败");
  assert.deepEqual(calls, ["lens/glm"]);

  scheduleSessionTitleSummary({
    sessionId: "summary-once",
    titleSource: "generated",
    rows: [
      { kind: "userInput", origin: "realUser", text: "帮我修登录失败" },
      { kind: "assistantText", text: "我先看认证模块" },
    ],
    fallbackProvider: "lens",
    fallbackModel: "glm",
    readSettings: async () => ({ enabled: true }),
    complete: async () => {
      calls.push("again");
      return "不该再来";
    },
    stillEligible: () => true,
    commit: () => {
      committed = "overwritten";
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["lens/glm"]);
  assert.equal(committed, "修复登录失败");
});

test("scheduleSessionTitleSummary skips custom titles and falls back when the summary model is missing", async () => {
  let called = false;
  scheduleSessionTitleSummary({
    sessionId: "summary-custom",
    titleSource: "custom",
    sessionName: "手改",
    rows: [{ kind: "userInput", origin: "realUser", text: "帮我修登录失败，这句够长" }],
    readSettings: async () => ({ enabled: true }),
    complete: async () => {
      called = true;
      return "不该生成";
    },
    stillEligible: () => true,
    commit: () => {
      called = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);

  const calls: string[] = [];
  scheduleSessionTitleSummary({
    sessionId: "summary-fallback",
    titleSource: "generated",
    rows: [{ kind: "userInput", origin: "realUser", text: "帮我修登录失败，这句够长" }],
    fallbackProvider: "talk",
    fallbackModel: "main",
    readSettings: async () => ({ enabled: true, provider: "gone", model: "missing" }),
    complete: async (request) => {
      calls.push(`${request.providerId}/${request.modelId}`);
      return request.providerId === "gone" ? null : "修复登录";
    },
    stillEligible: () => true,
    commit: (title) => {
      assert.equal(title, "修复登录");
    },
  });
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["gone/missing", "talk/main"]);
});

test("title summary waits for the session request, then runs without waiting for idle", async () => {
  const gate = createSessionFirstGate();
  let released = false;
  const pending = gate.ready().then(() => {
    released = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false);
  gate.sessionGoesFirst();
  await pending;
  assert.equal(released, true);
  await gate.ready();
});

test("closing a session unblocks a title summary that was waiting for the session", async () => {
  const gate = createSessionFirstGate();
  let released = false;
  const pending = gate.ready().then(() => {
    released = true;
  });
  gate.close();
  await pending;
  assert.equal(released, true);
  assert.equal(gate.closed, true);
});

test("a forked branch seeds its title from the first message after the fork", () => {
  const rows = [
    { kind: "userInput", origin: "realUser", text: "改登录页样式" },
    { kind: "assistantText", text: "改好了" },
    { kind: "userInput", origin: "realUser", text: "加个深色模式" },
    { kind: "assistantText", text: "加上了" },
    { kind: "userInput", origin: "realUser", text: "改成做移动端适配" },
    { kind: "assistantText", text: "先看断点" },
  ];
  assert.equal(countRealUserMessages(rows), 3);
  const seed = titleSummarySeed(rows, 2);
  assert.equal(seed?.userPrompt, "改成做移动端适配");
  assert.equal(seed?.realUserCount, 1);
  // 分叉点之前的助手回复也不能进种子，否则总结会跑回父会话的任务。
  assert.equal(seed?.assistantReply, "先看断点");
  assert.equal(titleSummarySeed(rows.slice(0, 4), 2), null);
});

test("a forked branch summarizes with the messages after the fork only", async () => {
  const prompts: string[] = [];
  let committed = "";
  scheduleSessionTitleSummary({
    sessionId: "summary-branch",
    parentSessionId: "parent",
    titleSource: "custom",
    sessionName: "分支-原题",
    forkTitle: { placeholder: "分支-原题", userCountBeforeFork: 1 },
    rows: [
      { kind: "userInput", origin: "realUser", text: "父会话的任务" },
      { kind: "assistantText", text: "父会话的回答" },
      { kind: "userInput", origin: "realUser", text: "分支后的新任务" },
    ],
    fallbackProvider: "lens",
    fallbackModel: "glm",
    readSettings: async () => ({ enabled: true }),
    complete: async (request) => {
      prompts.push(request.prompt);
      return "移动端适配改造";
    },
    stillEligible: () => true,
    commit: (title) => {
      committed = title;
    },
  });
  await waitFor(() => committed === "移动端适配改造");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /分支后的新任务/);
  assert.doesNotMatch(prompts[0] ?? "", /父会话的任务/);
  assert.doesNotMatch(prompts[0] ?? "", /父会话的回答/);
});

test("subagent child sessions still never summarize a title", async () => {
  let called = false;
  scheduleSessionTitleSummary({
    sessionId: "summary-child",
    parentSessionId: "parent",
    titleSource: "generated",
    rows: [{ kind: "userInput", origin: "realUser", text: "子代理的任务" }],
    fallbackProvider: "lens",
    fallbackModel: "glm",
    readSettings: async () => ({ enabled: true }),
    complete: async () => {
      called = true;
      return "不该生成";
    },
    stillEligible: () => true,
    commit: () => {
      called = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});

async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out");
}
