import assert from "node:assert/strict";
import test from "node:test";
import { applyConversationDeltas } from "@picode/shared/picode-protocol-v4";
import { PiToV4Projector } from "./projector.js";
import { asPiEvent, type PiAssistantDelta, type PiHostEvent } from "./types.js";

const retry = (attempt = 1): PiHostEvent => ({
  type: "auto_retry_start",
  attempt,
  maxAttempts: 3,
  delayMs: 1_000,
  errorMessage: `failed attempt ${attempt}`,
});

const progress: PiAssistantDelta[] = [
  { type: "text_delta", contentIndex: 0, delta: "Recovered answer" },
  { type: "thinking_delta", contentIndex: 0, delta: "Recovered thinking" },
  { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
  {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { id: "call-1", name: "read", arguments: { path: "README.md" } },
  },
];

for (const profile of ["continuous", "replayable"] as const) {
  for (const delta of progress) {
    test(`${profile}: ${delta.type} clears retry in the same batch as recovered output`, () => {
      const projector = new PiToV4Projector("s1", "e1", { profile });
      projector.apply({ type: "agent_start" });
      projector.apply(retry());
      projector.apply({ type: "agent_start" });
      projector.apply({ type: "message_start", message: { role: "assistant", id: "a1" } });
      // 投影器会原地更新内部快照；复制后才能验证增量没有漏发状态清除。
      const before = structuredClone(projector.getSnapshot());
      assert.equal(before.control.apiRetry?.attempt, 1);
      const deltas = projector.apply({ type: "message_update", assistantMessageEvent: delta });
      assert.equal(before.control.apiRetry?.attempt, 1);
      const restored = applyConversationDeltas(before, deltas);
      assert.equal(restored.control.apiRetry, null);
      assert.equal(restored.control.phase, "running");
      assert.equal(projector.getSnapshot().control.apiRetry, null);
      assert.ok(deltas.some((item) => item.op === "row.appended"));
      assert.equal(restored.rows.window.filter((row) => row.kind === "turnHeader").length, 1);
      assert.equal(projector.getSnapshot().control.canStop, true);
    });
  }
  for (const type of ["toolcall_start", "toolcall_delta"] as const) {
    test(`${profile}: SDK ${type} reads tool identity from the current partial block`, () => {
      const projector = new PiToV4Projector("s1", "e1", { profile });
      projector.apply({ type: "agent_start" });
      projector.apply(retry());
      const event = asPiEvent({
        type: "message_update",
        assistantMessageEvent: {
          type,
          contentIndex: 1,
          ...(type === "toolcall_delta" ? { delta: "" } : {}),
          partial: {
            content: [
              { type: "text", text: "Previous output" },
              { type: "toolCall", id: "call-sdk", name: "read", arguments: {} },
            ],
          },
        },
      });
      assert.ok(event);
      const before = structuredClone(projector.getSnapshot());
      const deltas = projector.apply(event);
      assert.equal(before.control.apiRetry?.attempt, 1);
      assert.equal(projector.getSnapshot().control.apiRetry, null);
      assert.equal(applyConversationDeltas(before, deltas).control.apiRetry, null);
      assert.equal(projector.getSnapshot().control.phase, "running");
      if (type === "toolcall_start") {
        const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
        assert.equal(tool?.toolCallId, "call-sdk");
        assert.equal(tool?.toolName, "Read");
      }
    });
  }
}

test("empty SDK tool starts keep retry visible without throwing", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  for (const partial of [
    undefined,
    { content: [] },
    { content: [{ type: "toolCall", id: "", name: "" }] },
  ]) {
    const event = asPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
    });
    assert.ok(event);
    projector.apply(event);
    assert.equal(projector.getSnapshot().control.apiRetry?.attempt, 1);
  }
});

test("request starts, empty deltas, and extension messages keep the retry status", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  for (const event of [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", id: "a1" } },
    { type: "message_start", message: { role: "custom", content: "Background notification" } },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "" },
    },
  ] satisfies PiHostEvent[]) {
    projector.apply(event);
    assert.equal(projector.getSnapshot().control.apiRetry?.attempt, 1, event.type);
  }
});

test("tool arguments resume output after an empty tool call start", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' },
  });
  assert.equal(projector.getSnapshot().control.apiRetry, null);
});

test("successful non-streaming completion clears retry without settling the turn", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Recovered" }],
    },
  });
  assert.equal(projector.getSnapshot().control.apiRetry, null);
  assert.equal(projector.getSnapshot().control.phase, "running");
});

test("partial output followed by another failed retry retains earlier failure details", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  projector.apply({ type: "message_update", assistantMessageEvent: progress[0]! });
  assert.equal(projector.getSnapshot().control.apiRetry, null);
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "second failure" },
  });
  projector.apply({ type: "agent_end", willRetry: true });
  projector.apply(retry(2));
  assert.deepEqual(
    projector.getSnapshot().control.apiRetry?.failures?.map((item) => item.attempt),
    [1, 2],
  );
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "final failure" },
  });
  projector.apply({
    type: "auto_retry_end",
    success: false,
    attempt: 2,
    finalError: "final failure",
  });
  projector.apply({ type: "agent_settled" });
  const done = projector.getSnapshot();
  assert.equal(done.control.apiRetry, null);
  assert.equal(done.control.phase, "error");
  assert.match(done.control.lastError?.detail ?? "", /1\. failed attempt 1/);
  assert.match(done.control.lastError?.detail ?? "", /2\. failed attempt 2/);
  assert.match(done.control.lastError?.detail ?? "", /3\. final failure/);
});

test("late retry success clears failure history even after output cleared the indicator", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply(retry());
  projector.apply({ type: "message_update", assistantMessageEvent: progress[0]! });
  projector.apply({ type: "auto_retry_end", success: true, attempt: 1 });
  projector.apply({ type: "auto_retry_end", success: true, attempt: 1 });
  projector.apply(retry());
  assert.equal(projector.getSnapshot().control.apiRetry?.failures?.length, 1);
});
