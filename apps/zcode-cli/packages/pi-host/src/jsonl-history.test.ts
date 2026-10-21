import assert from "node:assert/strict";
import test from "node:test";
import { PiToV4Projector } from "./projector.js";
import { readPiJsonl, shouldApplyStoredSessionTitle } from "./jsonl-history.js";

const sample = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"just say pong"}]}}',
  '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"ok"},{"type":"text","text":"pong"}]}}',
  '{"type":"message","id":"u2","timestamp":"2026-01-02T03:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"ls please"}]}}',
  '{"type":"message","id":"a2","timestamp":"2026-01-02T03:05:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"listing"},{"type":"toolCall","id":"c1","name":"ls","arguments":{"path":"."}}]}}',
  '{"type":"message","id":"t1","timestamp":"2026-01-02T03:05:02.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"ls","content":[{"type":"text","text":"(empty)"}],"isError":false}}',
  '{"type":"message","id":"a3","timestamp":"2026-01-02T03:05:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"empty dir"}]}}',
].join("\n");

test("replay does not publish the first-message title", () => {
  const events = readPiJsonl(sample).events;
  const projector = new PiToV4Projector("s1", "e1");
  projector.setTitle("修登录", "generated");
  projector.replay(events);
  assert.equal(projector.getSnapshot().meta.title, "修登录");
  assert.equal(projector.getSnapshot().meta.titleSource, "generated");
  const live = new PiToV4Projector("s1", "e1");
  for (const event of events) live.apply(event);
  assert.equal(live.getSnapshot().meta.title, "just say pong");
});

test("stored history title does not roll a summary back to the first message", () => {
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "修登录",
      currentTitleSource: "generated",
      storedTitle: "just say pong",
      storedTitleNamed: false,
    }),
    false,
  );
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "just say pong",
      currentTitleSource: "generated",
      storedTitle: "修登录",
      storedTitleNamed: true,
    }),
    true,
  );
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "",
      currentTitleSource: "default",
      storedTitle: "just say pong",
      storedTitleNamed: false,
    }),
    true,
  );
});

test("replay matches per-event apply", () => {
  const events = readPiJsonl(sample).events;
  const stepwise = new PiToV4Projector("s1", "e1");
  for (const event of events) stepwise.apply(event);
  const bulk = new PiToV4Projector("s1", "e1");
  bulk.replay(events);
  const view = (rows: ReturnType<PiToV4Projector["getSnapshot"]>["rows"]["window"]) =>
    rows.map((row) => ({
      kind: row.kind,
      text: "text" in row ? row.text : undefined,
      actions: "actions" in row ? row.actions : undefined,
    }));
  assert.deepEqual(view(bulk.getSnapshot().rows.window), view(stepwise.getSnapshot().rows.window));
});

test("summarize skips header-only jsonl", () => {
  const parsed = readPiJsonl(
    '{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  );
  assert.equal(parsed.summary, null);
  assert.equal(parsed.events.length, 0);
});

test("extension command output is replayed and is not a user message", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z"}',
    '{"type":"custom","customType":"zcode-extension-output","id":"c1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","data":{"command":"web-tools","text":"workflow: none"}}',
  ].join("\n");
  const parsed = readPiJsonl(content);
  const event = parsed.events.find((item) => item.type === "extension_output");
  assert.equal(event?.type, "extension_output");
  if (event?.type !== "extension_output") return;
  assert.equal(event.command, "web-tools");
  assert.equal(event.text, "workflow: none");
});

test("summarize skips a bare slash command and a command session name", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
    '{"type":"session_info","name":"/plannotator-plan-mode"}',
    '{"type":"message","id":"u0","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"/plannotator-plan-mode"}]}}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"修登录"}]}}',
  ].join("\n");
  assert.equal(readPiJsonl(content).summary?.title, "修登录");
});

test("summarize drops Pi image resize notes from the title", () => {
  const note =
    "[Image: original 2560x1392, displayed at 2000x1088. Multiply coordinates by 1.28 to map to original image.]";
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z"}',
    `{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"\u770b\u8fd9\u5f20\\n\\n${note}"}]}}`,
  ].join("\n");
  assert.equal(readPiJsonl(content).summary?.title, "\u770b\u8fd9\u5f20");
});

test("summarize uses first user text and last assistant preview", () => {
  const { summary } = readPiJsonl(sample);
  assert.ok(summary);
  assert.equal(summary.title, "just say pong");
  assert.equal(summary.sessionId, "s1");
  assert.equal(summary.cwd, "C:\\work");
  assert.equal(summary.lastAssistantPreview, "empty dir");
  assert.equal(summary.createdAt, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(summary.lastActivityAt, Date.parse("2026-01-02T03:05:03.000Z"));
});

test("fork keeps the new header time and ignores older copied messages", () => {
  const content = [
    '{"type":"session","id":"child","timestamp":"2026-09-24T05:13:57.799Z","cwd":"/work"}',
    '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-24T03:21:15.267Z","message":{"role":"user","content":[{"type":"text","text":"ping2"}]}}',
    '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-24T03:21:17.568Z","message":{"role":"assistant","content":[{"type":"text","text":"pong2"}]}}',
    '{"type":"custom","id":"c1","parentId":"a1","timestamp":"2026-09-24T05:13:47.239Z"}',
    '{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-09-24T05:14:02.184Z","message":{"role":"user","content":[{"type":"text","text":"ping3"}]}}',
  ].join("\n");
  const { summary } = readPiJsonl(content);
  assert.equal(summary?.createdAt, Date.parse("2026-09-24T05:13:57.799Z"));
  assert.equal(summary?.lastActivityAt, Date.parse("2026-09-24T05:14:02.184Z"));
});

test("replay follows the active leaf and drops the edited-away branch", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\work"}',
    '{"type":"message","id":"sys","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"system","content":"ctx"}}',
    '{"type":"message","id":"u1","parentId":"sys","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"ping"}]}}',
    '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-02T03:04:08.000Z","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}',
    '{"type":"message","id":"u2","parentId":"sys","timestamp":"2026-01-02T03:04:09.000Z","message":{"role":"user","content":[{"type":"text","text":"ping2"}]}}',
    '{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"pong2"}]}}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const texts = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput" || row.kind === "assistantText")
    .map((row) => ("text" in row ? row.text : ""));
  assert.deepEqual(texts, ["ping2", "pong2"]);
});

test("replay keeps a compaction summary", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"ping"}]}}',
    '{"type":"compaction","id":"k1","parentId":"u1","timestamp":"2026-01-02T03:04:07.000Z","summary":"user said ping","tokensBefore":40}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1");
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const marker = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    marker && marker.kind === "timelineMarker" && marker.marker.type === "compact"
      ? marker.marker.summary
      : "",
    "user said ping",
  );
});

test("settled jsonl uses message timestamps for work duration", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(sample).events) projector.apply(event);
  const headers = projector.getSnapshot().rows.window.filter((row) => row.kind === "turnHeader");
  const last = headers.at(-1);
  assert.equal(last && last.kind === "turnHeader" ? last.state : "", "completedSuccess");
  assert.equal(last && last.kind === "turnHeader" ? last.activeMs : -1, 3_000);
  assert.equal(projector.getSnapshot().control.phase === "running", false);
});

test("live subagent jsonl stays open and keeps the file clock", () => {
  const content = [
    '{"type":"session","id":"child","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"explore"}]}}',
    '{"type":"message","id":"a1","timestamp":"2026-01-02T03:06:42.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"grep","arguments":{"pattern":"todo"}}]}}',
  ].join("\n");
  const projector = new PiToV4Projector("child", "e1");
  for (const event of readPiJsonl(content, { settle: false }).events) projector.apply(event);
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(header && header.kind === "turnHeader" ? header.state : "", "running");
  assert.equal(
    header && header.kind === "turnHeader" ? header.startedAt : 0,
    Date.parse("2026-01-02T03:04:06.000Z"),
  );
  assert.equal(header && header.kind === "turnHeader" ? header.endedAt : 0, undefined);
  assert.equal(projector.getSnapshot().control.phase, "running");
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.status : "", "running");
});

test("replay hydrates user, assistant, tools into projector", () => {
  const { events } = readPiJsonl(sample);
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of events) projector.apply(event);
  const kinds = projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.ok(kinds.includes("userInput"));
  assert.ok(kinds.includes("assistantText"));
  assert.ok(kinds.includes("toolCall"));
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.status : undefined, "success");
  assert.equal(projector.getSnapshot().control.phase === "running", false);
});

test("replay keeps later assistant text after tools and plugin messages", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"export done?"}]}}',
    '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still exporting"}]}}',
    '{"type":"custom_message","id":"p1","customType":"background-bash-task","display":true,"content":"background task done","timestamp":"2026-01-02T03:04:08.000Z"}',
    '{"type":"message","id":"a2","timestamp":"2026-01-02T03:04:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"export finished"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"wsl -l"}}]}}',
    '{"type":"message","id":"t1","timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}}',
    '{"type":"message","id":"a3","timestamp":"2026-01-02T03:04:11.000Z","message":{"role":"assistant","content":[{"type":"text","text":"vhdx removed"}]}}',
    '{"type":"message","id":"b1","timestamp":"2026-01-02T03:04:12.000Z","message":{"role":"bashExecution","command":"docker ps","output":"none","exitCode":0}}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const texts = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "assistantText")
    .map((row) => (row.kind === "assistantText" ? row.text : ""));
  assert.deepEqual(texts, [
    "still exporting",
    "background task done",
    "export finished",
    "vhdx removed",
  ]);
  const tools = projector.getSnapshot().rows.window.filter((row) => row.kind === "toolCall");
  assert.equal(tools.length, 2);
  assert.equal(tools.every((row) => row.kind === "toolCall" && row.status === "success"), true);
});

function turnHeaderOf(projector: PiToV4Projector) {
  const header = projector
    .getSnapshot()
    .rows.window.find((row) => row.kind === "turnHeader");
  assert.ok(header !== undefined && header.kind === "turnHeader");
  return header;
}

const usageLine =
  '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:17.000Z","message":{"role":"assistant","provider":"lens","model":"m","content":[{"type":"text","text":"hello"}],"usage":{"input":1505,"output":239,"cacheRead":86016,"cacheWrite":0,"totalTokens":87760},"timestamp":1767323051000,"durationMs":5202}}';

const usageSample = [
  '{"type":"session","version":3,"id":"s2","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
  usageLine,
].join("\n");

test("重放把本轮用量带回 turnHeader，重开会话也能看到", () => {
  const projector = new PiToV4Projector("s2", "e1");
  projector.replay(readPiJsonl(usageSample).events);
  const header = turnHeaderOf(projector);
  assert.deepEqual(header.usage, {
    providerId: "lens",
    modelId: "m",
    inputTokens: 1505,
    cacheReadTokens: 86_016,
    cacheWriteTokens: 0,
    outputTokens: 239,
    llmDurationMs: 5202,
  });
});

test("会话累计量随重放补齐：token、轮次、步数", () => {
  const projector = new PiToV4Projector("s2", "e1");
  projector.replay(readPiJsonl(usageSample).events);
  // 冷恢复不需要额外种子：回放逐条走 message_end，与实时同一条累加路径。
  assert.deepEqual(projector.getSnapshot().usage.cumulative, {
    inputTokens: 1_505,
    outputTokens: 239,
    cacheReadTokens: 86_016,
    cacheWriteTokens: 0,
    turns: 1,
    steps: 1,
    // 模型用时来自 jsonl 里的 durationMs。
    llmMs: 5_202,
    // 重放不打首 token 打点，所以解码段与工具耗时都没有事实，保持 0。
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
  });
});

test("零用量的调用不进步数，也不占 token", () => {
  // 失败、中断、deferred 回填也会写 message_end，Pi 这时给的是全零 usage。
  const zeroUsage =
    '{"type":"message","id":"a2","timestamp":"2026-01-02T03:04:20.000Z","message":{"role":"assistant","provider":"lens","model":"m","content":[{"type":"text","text":"x"}],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}}}';
  const sample = `${usageSample}\n${zeroUsage}`;
  const projector = new PiToV4Projector("s5", "e1");
  projector.replay(readPiJsonl(sample).events);
  const cumulative = projector.getSnapshot().usage.cumulative;
  assert.equal(cumulative.steps, 1);
  assert.equal(cumulative.turns, 1);
  assert.equal(cumulative.outputTokens, 239);
});

test("重复重放不重复累计：reload 先把累计归零", () => {
  // reload 会重置所有行游标再 replay 整份 jsonl，但累计量不在行里。
  // 切分支、编辑重发、子代理 historyWatch 重画都会走到这条路径。
  const events = readPiJsonl(usageSample).events;
  const projector = new PiToV4Projector("s7", "e1");
  projector.replay(events);
  const once = projector.getSnapshot().usage.cumulative;
  projector.reload(events);
  assert.deepEqual(projector.getSnapshot().usage.cumulative, once);
  projector.reload(events);
  assert.deepEqual(projector.getSnapshot().usage.cumulative, once);
});

test("回退到早期分支后，累计量按新事件流重算", () => {
  // 两轮各一次模型调用；回退到第一轮之后，第二轮的数字必须消失。
  const secondUsageLine = usageLine
    .replace('"id":"a1"', '"id":"a2"')
    .replace('"input":1505', '"input":700')
    .replace('"output":239', '"output":100');
  const sample = [
    '{"type":"session","version":3,"id":"s10","timestamp":"2026-01-02T03:04:05.000Z"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    usageLine,
    '{"type":"message","id":"u2","timestamp":"2026-01-02T03:06:06.000Z","message":{"role":"user","content":[{"type":"text","text":"again"}]}}',
    secondUsageLine,
  ].join("\n");
  const events = readPiJsonl(sample).events;
  const projector = new PiToV4Projector("s10", "e1");
  projector.reload(events);
  assert.equal(projector.getSnapshot().usage.cumulative.turns, 2);
  assert.equal(projector.getSnapshot().usage.cumulative.steps, 2);

  // 回退到第二轮之前：只重放前半段事件。累计量只能从事件流重算，
  // 从行上反推拆不出步数与工具耗时。
  const turnStarts = events.flatMap((event, index) =>
    event.type === "agent_start" ? [index] : [],
  );
  const cut = turnStarts[1];
  assert.ok(cut !== undefined);
  projector.reload(events.slice(0, cut));
  const cumulative = projector.getSnapshot().usage.cumulative;
  assert.equal(cumulative.turns, 1);
  assert.equal(cumulative.steps, 1);
  assert.equal(cumulative.inputTokens, 1_505);
  assert.equal(cumulative.outputTokens, 239);
  assert.equal(cumulative.llmMs, 5_202);
});

test("实时开轮累加轮次，重试再发的 agent_start 不重复计", () => {
  const projector = new PiToV4Projector("s6", "e1");
  projector.apply({ type: "agent_start" });
  assert.equal(projector.getSnapshot().usage.cumulative.turns, 1);
  // Pi 重试会再发 agent_start，而上一轮仍在跑。早退不重复计轮，也不清停止意图。
  projector.apply({ type: "agent_start" });
  assert.equal(projector.getSnapshot().usage.cumulative.turns, 1);
});

test("legacy 消息没有 durationMs 时用落盘时刻与请求开始时刻回退", () => {
  // 落盘时间减请求开始时间：17 秒 - 11 秒 = 6 秒，其中 5.2 秒是真实耗时，
  // 回退值略高估（含持久化开销），只用于历史重放。
  const legacy = usageLine.replace(',"durationMs":5202', "");
  const sample = [
    '{"type":"session","version":3,"id":"s3","timestamp":"2026-01-02T03:04:05.000Z"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    legacy,
  ].join("\n");
  const projector = new PiToV4Projector("s3", "e1");
  projector.replay(readPiJsonl(sample).events);
  const header = turnHeaderOf(projector);
  // 落盘时刻与 fixture 里的 message.timestamp 相差 6 秒，回退值就是它。
  assert.equal(header.usage?.llmDurationMs, 6_000);
});

test("实时事件累积本轮用量，首 token 等待有打点", () => {
  const projector = new PiToV4Projector("s4", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  // 请求开始时刻由 Pi 的 AssistantMessage.timestamp 给。
  const requestStartedAt = Date.now() - 1_000;
  projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a1", timestamp: requestStartedAt },
  });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "he" },
  });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      id: "a1",
      content: [{ type: "text", text: "hello" }],
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 },
      durationMs: 900,
      provider: "lens",
      model: "m",
    },
  });
  const header = turnHeaderOf(projector);
  assert.equal(header.usage?.inputTokens, 10);
  assert.equal(header.usage?.outputTokens, 20);
  assert.equal(header.usage?.llmDurationMs, 900);
  // 首个增量在请求开始约 1 秒后到达，TTFT 应落在合理区间而不是 0。
  assert.ok((header.usage?.ttftMs ?? 0) >= 900, `实际 ${String(header.usage?.ttftMs)}`);
  const cumulative = projector.getSnapshot().usage.cumulative;
  assert.equal(cumulative.llmMs, 900);
  assert.equal(cumulative.steps, 1);
  assert.equal(cumulative.ttftSteps, 1);
  assert.equal(cumulative.ttftMs, header.usage?.ttftMs);
  // 首 token 等得比总时长还久时解码段钳到 0，不出现负数时长。
  assert.equal(cumulative.decodeMs, 0);
  // 解码 token 仍计入：它是输出量的事实，与时长是否可信无关。
  assert.equal(cumulative.decodeTokens, 20);
});

test("工具耗时按两端时间差进会话累计", () => {
  const projector = new PiToV4Projector("s9", "e1");
  projector.apply({ type: "agent_start", at: 500 });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  projector.apply({
    type: "tool_execution_start",
    at: 1_000,
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  projector.apply({
    type: "tool_execution_end",
    at: 4_000,
    toolCallId: "t1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  assert.equal(projector.getSnapshot().usage.cumulative.toolMs, 3_000);
});

test("没有 usage 的消息不产出用量，也不画卡", () => {
  const projector = new PiToV4Projector("s5", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  projector.apply({
    type: "message_end",
    message: { role: "assistant", id: "a1", content: [{ type: "text", text: "ok" }] },
  });
  assert.equal(turnHeaderOf(projector).usage, undefined);
});

test("全零用量的调用不产出用量卡", () => {
  const projector = new PiToV4Projector("s6", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      id: "a1",
      content: [{ type: "text", text: "boom" }],
      stopReason: "error",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  });
  assert.equal(turnHeaderOf(projector).usage, undefined);
});

test("失败尝试的零用量不占时长，也不抹掉首 token 等待", () => {
  const projector = new PiToV4Projector("s7", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  // 第一次尝试超时：Pi 给全零 usage、有 timestamp、没有 durationMs，但仍会 emit 两个事件。
  projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a-fail", timestamp: Date.now() - 60_000 },
  });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      id: "a-fail",
      content: [],
      stopReason: "error",
      errorMessage: "timeout",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  });
  // 第二次成功。
  projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a-ok", timestamp: Date.now() - 5_000 },
  });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
  });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      id: "a-ok",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 },
      durationMs: 900,
      provider: "lens",
      model: "m",
    },
  });
  const header = turnHeaderOf(projector);
  assert.equal(header.usage?.outputTokens, 20);
  // 失败尝试的 60 秒不能进分母。
  assert.equal(header.usage?.llmDurationMs, 900);
  // 失败尝试没有首 token，但它整次被跳过，不该把成功那次的 TTFT 连带丢掉。
  assert.ok(header.usage?.ttftMs !== undefined, "首 token 等待被失败尝试抹掉了");
});

test("先调工具再补正文时，首 token 从 toolCall 算起", () => {
  const projector = new PiToV4Projector("s8", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a1", timestamp: Date.now() - 2_000 },
  });
  // 只发 toolCall，没有 text_delta：一条只调工具的消息不能等到正文才算首 token。
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"cmd"' },
  });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      id: "a1",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
      durationMs: 3_000,
    },
  });
  const header = turnHeaderOf(projector);
  assert.ok(header.usage?.ttftMs !== undefined, "toolCall 没被当成首 token");
  assert.ok((header.usage?.ttftMs ?? 0) >= 1_900, `实际 ${String(header.usage?.ttftMs)}`);
});

test("分叉来源从 session header 读出，供分支图谱建边", () => {
  const forked = [
    '{"type":"session","version":3,"id":"01a15cc3","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:/work","parentSession":"C:/sessions/2026-01-01T00-00-00-000Z_sess_9efac5ef.jsonl"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
  ].join("\n");
  assert.equal(
    readPiJsonl(forked).summary?.parentSession,
    "C:/sessions/2026-01-01T00-00-00-000Z_sess_9efac5ef.jsonl",
  );
  // 根会话没有该字段，不能凭空造出一条边。
  assert.equal(readPiJsonl(sample).summary?.parentSession, undefined);
});
