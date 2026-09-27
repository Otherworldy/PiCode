import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { capRowForWire } from "./projection-rows.js";

test("wire tool rows keep only the head and tail", () => {
  const headBytes = PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes;
  const tailBytes = PROTOCOL_V4_LIMITS.toolOutputFinalTailBytes;
  const text = `${"a".repeat(headBytes)}MIDDLE${"z".repeat(tailBytes)}`;
  const row = {
    kind: "toolCall",
    toolCallId: "c1",
    inputText: text,
    output: { text },
    error: { code: "tool.error", message: text },
  } as ToolCallRow;
  const capped = capRowForWire(row);
  assert.equal(row.output?.text, text);
  assert.ok(capped.kind === "toolCall");
  if (capped.kind !== "toolCall") return;
  assert.ok(capped.inputText.length < text.length);
  assert.ok(capped.inputText.startsWith("a"));
  assert.ok(capped.inputText.endsWith("z"));
  assert.equal(capped.output?.truncated?.totalBytes, Buffer.byteLength(text));
  assert.ok(!capped.output?.text.includes("MIDDLE"));
  assert.ok(!capped.error?.message.includes("MIDDLE"));
});
