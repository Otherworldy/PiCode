import assert from "node:assert/strict";
import { test } from "node:test";
import { PiUsageAccumulator } from "./pi-usage.js";

const window = { since: 0, until: Date.parse("2026-09-23T00:00:00.000Z"), tzOffsetMs: 0 };

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

test("pi usage counts the leaf, cache, tools, and does not recount a fork", () => {
  const usage = new PiUsageAccumulator();
  usage.addFile(
    [
      line({ type: "session", id: "sess", timestamp: "2026-09-22T00:00:00.000Z" }),
      line({
        type: "message",
        id: "user-1",
        parentId: "sess",
        timestamp: "2026-09-22T01:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
      line({
        type: "message",
        id: "old",
        parentId: "user-1",
        timestamp: "2026-09-22T01:01:00.000Z",
        message: {
          role: "assistant",
          model: "old-model",
          content: [{ type: "text", text: "dropped" }],
          usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200 },
        },
      }),
      line({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-09-22T01:02:00.000Z",
        message: {
          role: "assistant",
          model: "pi-model",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "read" }],
          usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 5, totalTokens: 10 },
        },
      }),
      line({
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-09-22T01:03:00.000Z",
        message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: true },
      }),
    ].join(""),
    window,
  );
  usage.addFile(
    [
      line({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-09-22T01:02:00.000Z",
        message: {
          role: "assistant",
          model: "pi-model",
          usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 5, totalTokens: 47 },
        },
      }),
      line({
        type: "message",
        id: "user-2",
        parentId: "assistant-1",
        timestamp: "2026-09-22T02:00:00.000Z",
        message: { role: "user", content: "again" },
      }),
    ].join(""),
    window,
  );

  const query = usage.toQuery();
  assert.equal(query.totals.totalTokens, 47);
  assert.equal(query.totals.inputTokens, 45);
  assert.equal(query.totals.cacheReadTokens, 30);
  assert.equal(query.totals.modelRequestCount, 1);
  assert.equal(query.models[0]?.modelId, "pi-model");
  assert.equal(query.turnTotals.totalTurns, 2);
  assert.equal(query.turnTotals.totalSessions, 2);
  assert.equal(query.toolTotals.toolCallCount, 1);
  assert.equal(query.toolTotals.toolErrorCount, 1);
  assert.equal(query.tools[0]?.toolName, "read");
});
