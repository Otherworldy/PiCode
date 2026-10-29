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
