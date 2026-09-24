import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { planTurnFileRewind, undoEdits } from "./file-rewind.js";
import { PiToV4Projector } from "./projector.js";

test("undoEdits restores each unique replacement", () => {
  const undone = undoEdits("ONE\r\nTWO\r\n", [
    { oldText: "one", newText: "ONE" },
    { oldText: "two", newText: "TWO" },
  ]);
  assert.equal(undone, "one\r\ntwo\r\n");
});

test("undoEdits refuses a missing or repeated replacement", () => {
  assert.equal(undoEdits("same same", [{ oldText: "a", newText: "same" }]), null);
  assert.equal(undoEdits("gone", [{ oldText: "old", newText: "" }]), null);
});

test("planTurnFileRewind restores edits and deletes a matching write", async () => {
  const rows = [
    tool("turn:1", "Edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
    tool("turn:1", "Write", { path: "b.ts", content: "all" }),
    tool("turn:1", "Bash", { command: "rm x" }),
  ];
  const plan = await planTurnFileRewind(rows, "turn:1", async (path) =>
    path === "a.ts" ? { content: "new\n" } : { content: "all" },
  );
  assert.equal(plan.preview.canApply, true);
  assert.deepEqual(plan.restores, [{ path: "a.ts", content: "old\n" }]);
  assert.deepEqual(plan.deletes, ["b.ts"]);
  assert.equal(plan.preview.ignoredFiles[0]?.reason, "bash_ignored");
});

test("planTurnFileRewind refuses a write whose bytes changed", async () => {
  const rows = [tool("turn:1", "Write", { path: "b.ts", content: "all" })];
  const plan = await planTurnFileRewind(rows, "turn:1", async () => ({ content: "changed" }));
  assert.equal(plan.preview.canApply, false);
  assert.equal(plan.preview.unsafeFiles[0]?.reason, "external_modified");
});

test("planTurnFileRewind restores when every edit still matches", async () => {
  const rows = [tool("turn:1", "Edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] })];
  const plan = await planTurnFileRewind(rows, "turn:1", async () => ({ content: "new\n" }));
  assert.equal(plan.preview.canApply, true);
  assert.deepEqual(plan.restores, [{ path: "a.ts", content: "old\n" }]);
});

test("projector counts a write on the turn header", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "write",
    args: { path: "hello.html", content: "<h1>Hello</h1>" },
  });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "write",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  projector.apply({ type: "agent_end" });
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(header && header.kind === "turnHeader" ? header.fileChanges?.files : 0, 1);
  assert.equal(header && header.kind === "turnHeader" ? header.actions?.canRewindFiles : false, true);
});

test("projector exposes file rewind on a settled edit turn", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "edit",
    args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
  });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "edit",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  projector.apply({ type: "agent_end" });
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(header && header.kind === "turnHeader" ? header.fileChanges?.files : 0, 1);
  assert.equal(header && header.kind === "turnHeader" ? header.actions?.canRewindFiles : false, true);
  projector.markTurnFilesReverted(header && header.kind === "turnHeader" ? header.turnId : "");
  const reverted = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(reverted && reverted.kind === "turnHeader" ? reverted.fileChanges?.state : "", "reverted");
  assert.equal(reverted && reverted.kind === "turnHeader" ? reverted.actions?.canRewindFiles : false, undefined);
});

function tool(turnId: string, toolName: string, args: unknown): ConversationRow {
  return {
    rowId: 1,
    turnId,
    entityId: "row:1",
    createdAt: 0,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: toolName,
    toolName,
    status: "success",
    inputText: JSON.stringify(args),
  };
}
