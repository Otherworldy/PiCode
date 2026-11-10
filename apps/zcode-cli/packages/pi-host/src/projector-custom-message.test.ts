import assert from "node:assert/strict";
import test from "node:test";
import { PiToV4Projector } from "./projector.js";

function projector() {
  const instance = new PiToV4Projector("s1", "e1");
  instance.apply({ type: "agent_start" });
  return instance;
}

function assistantTexts(instance: PiToV4Projector) {
  return instance
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "assistantText")
    .map((row) => row.text);
}

test("a custom message shows up as assistant text in the live transcript", () => {
  const instance = projector();
  instance.apply({
    type: "message_start",
    message: {
      role: "custom",
      customType: "picode_subagent_result",
      display: true,
      content: '子代理 "scout" 已完成。',
      id: "m1",
    },
  });

  // jsonl-history 回放时把它合成 assistant 正文，实时必须画成同一种行。
  assert.deepEqual(assistantTexts(instance), ['子代理 "scout" 已完成。']);
});

test("a subagent settlement carries its structured facts onto the row", () => {
  const instance = projector();
  instance.apply({
    type: "message_start",
    message: {
      role: "custom",
      customType: "picode_subagent_result",
      display: true,
      content: '子代理 "reviewer" 已完成。\nchildSessionId: child-1\n\n报告正文',
      details: {
        agent: "reviewer",
        status: "success",
        childSessionId: "child-1",
        text: "报告正文",
      },
      id: "m1",
    },
  });

  const row = instance.getSnapshot().rows.window.find((item) => item.kind === "assistantText");
  // 正文一仍完整（模型看到的就是这一份），卡片另拿 details 画。
  assert.match(row?.kind === "assistantText" ? row.text : "", /\u62a5\u544a\u6b63\u6587/u);
  assert.deepEqual(row?.kind === "assistantText" ? row.subagentSettlement : undefined, {
    agent: "reviewer",
    status: "success",
    childSessionId: "child-1",
    text: "报告正文",
  });
});

test("a settlement row never becomes the turn's fork or retry anchor", () => {
  const instance = projector();
  instance.apply({ type: "agent_end" });
  instance.apply({
    type: "message_start",
    message: {
      role: "custom",
      display: true,
      content: '子代理 "scout" 已完成。',
      details: { agent: "scout", status: "success", text: "answer" },
    },
  });
  instance.apply({ type: "agent_settled" });

  const row = instance.getSnapshot().rows.window.find((item) => item.kind === "assistantText");
  // 卡片不是答复：分叉/重试只能挂在真正的最后一条正文上。
  assert.equal(row?.actions, undefined);
});

test("malformed settlement details fall back to plain assistant text", () => {
  const instance = projector();
  instance.apply({
    type: "message_start",
    message: {
      role: "custom",
      display: true,
      content: "没有可用的结构化事实",
      // 缺 status：宁可当普通正文，也不要一张只剩角色名的卡片。
      details: { agent: "scout", text: "answer" },
    },
  });

  const row = instance.getSnapshot().rows.window.find((item) => item.kind === "assistantText");
  assert.equal(row?.kind, "assistantText");
  assert.equal(row?.kind === "assistantText" ? row.subagentSettlement : "missing", undefined);
});

test("a custom message with display false stays out of the transcript", () => {
  const instance = projector();
  instance.apply({
    type: "message_start",
    message: { role: "custom", customType: "ui-design", display: false, content: "别画" },
  });

  assert.deepEqual(assistantTexts(instance), []);
});

test("an empty custom message does not add a row", () => {
  const instance = projector();
  instance.apply({
    type: "message_start",
    message: { role: "custom", display: true, content: "   " },
  });

  assert.deepEqual(assistantTexts(instance), []);
});

test("a tool result that reports backgrounded marks its row", () => {
  const instance = projector();
  instance.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "picode_subagent",
    args: { agent: "scout", run_in_background: true },
  });
  instance.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "picode_subagent",
    isError: false,
    result: { content: [{ type: "text", text: "started in background" }], details: { backgrounded: true } },
  });

  const row = instance
    .getSnapshot()
    .rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === "c1");
  assert.equal(row?.backgrounded, true);
});

test("a foreground tool result is not marked as backgrounded", () => {
  const instance = projector();
  instance.apply({
    type: "tool_execution_start",
    toolCallId: "c2",
    toolName: "picode_subagent",
    args: { agent: "scout" },
  });
  instance.apply({
    type: "tool_execution_end",
    toolCallId: "c2",
    toolName: "picode_subagent",
    isError: false,
    result: { content: [{ type: "text", text: "done" }], details: {} },
  });

  const row = instance
    .getSnapshot()
    .rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === "c2");
  assert.equal(row?.backgrounded, undefined);
});
