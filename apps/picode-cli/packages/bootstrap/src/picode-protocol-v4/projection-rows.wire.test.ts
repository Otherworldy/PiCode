import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, ToolCallRow } from "@picode/shared/picode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@picode/shared/picode-protocol-v4";
import { capRowForWire, wireTailRows } from "./projection-rows.js";

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

// 尾窗会把最后一轮的 turnHeader 切到窗口外，运行行因此整行消失。
// 见 docs/specs/conversation-tail-window-turn-header.md。
function row(
  rowId: number,
  turnId: string,
  kind: "turnHeader" | "userInput" | "toolCall",
): ConversationRow {
  const base = { rowId, turnId, createdAt: rowId, createdAtSeq: rowId };
  if (kind === "turnHeader") {
    return {
      ...base,
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state: "running",
      startedAt: rowId,
    };
  }
  if (kind === "userInput") {
    return { ...base, kind: "userInput", text: `q${rowId}`, origin: "realUser" };
  }
  return {
    ...base,
    kind: "toolCall",
    toolCallId: `c${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "echo hi",
    startedAt: rowId,
    endedAt: rowId,
  };
}

test("wire tail keeps the last turn's header when the turn is longer than the window", () => {
  const rows: ConversationRow[] = [row(1, "t1", "turnHeader"), row(2, "t1", "userInput")];
  for (let id = 3; id <= 80; id += 1) rows.push(row(id, "t2", "toolCall"));
  rows[2] = row(3, "t2", "turnHeader");
  rows[3] = row(4, "t2", "userInput");

  const tail = wireTailRows(rows, 10);
  assert.equal(tail.at(0)?.kind, "turnHeader");
  assert.equal(tail.at(0)?.turnId, "t2");
  assert.equal(tail.at(1)?.kind, "userInput");
  // 只补两个锚点，窗口不任意扩张。
  assert.equal(tail.length, 12);
  // 尾部内容保持原序、原长度。
  assert.deepEqual(
    tail.slice(-10).map((item) => item.rowId),
    rows.slice(-10).map((item) => item.rowId),
  );
});

test("wire tail is untouched when the last turn fits in the window", () => {
  const rows: ConversationRow[] = [row(1, "t1", "turnHeader"), row(2, "t1", "userInput")];
  for (let id = 3; id <= 40; id += 1) rows.push(row(id, "t1", "toolCall"));
  const tail = wireTailRows(rows, 60);
  assert.deepEqual(
    tail.map((item) => item.rowId),
    rows.map((item) => item.rowId),
  );
});
