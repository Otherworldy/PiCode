import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  planSuffixFileRewind,
  planTurnFileRewind,
  suffixTurnIds,
  summarizeTurnFileChanges,
  undoEdits,
} from "./file-rewind.js";
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

test("summarizeTurnFileChanges keeps review patches", () => {
  const summary = summarizeTurnFileChanges(
    [
      tool("turn:1", "Edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
      tool("turn:1", "Write", { path: "b.ts", content: "all\n" }),
    ],
    "turn:1",
  );
  assert.deepEqual(
    summary?.items.map((item) => [item.path, item.patches[0]?.lines]),
    [
      ["a.ts", ["-old", "+new"]],
      ["b.ts", ["+all"]],
    ],
  );
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
  const rows = [
    tool("turn:1", "Edit", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
  ];
  const plan = await planTurnFileRewind(rows, "turn:1", async () => ({ content: "new\n" }));
  assert.equal(plan.preview.canApply, true);
  assert.deepEqual(plan.restores, [{ path: "a.ts", content: "old\n" }]);
});

test("planSuffixFileRewind refuses a write that overwrote an existing file", async () => {
  // 覆盖已有文件的 Write 拿不到旧内容：退回成删除会把锚点之前的文件一起删掉。
  const rows = [
    header("turn:1"),
    {
      ...tool("turn:1", "Write", { path: "a.ts", content: "all" }),
      output: {
        text: "ok",
        display: {
          kind: "file_diff",
          filePath: "a.ts",
          additions: 1,
          deletions: 1,
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+all"] },
          ],
        },
      },
    },
  ];
  const plan = await planSuffixFileRewind(rows, "turn:1", async () => ({ content: "all" }));
  assert.equal(plan.preview.canApply, false);
  assert.equal(plan.preview.unsafeFiles[0]?.reason, "checkpoint_missing");
  assert.deepEqual(plan.deletes, []);
});

test("planSuffixFileRewind unwinds every turn from the anchor on", async () => {
  // turn:1 写 a.ts，turn:2 再改 a.ts 并新建 b.ts。回退到 turn:1 之前要求两个 turn 一起撤销，
  // 最终内容是最早那次写入之前的状态，而不是只撤 turn:1。
  const rows = [
    header("turn:1"),
    tool("turn:1", "Write", { path: "a.ts", content: "one" }),
    header("turn:2"),
    tool("turn:2", "Edit", { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] }),
    tool("turn:2", "Write", { path: "b.ts", content: "all" }),
  ];
  const plan = await planSuffixFileRewind(rows, "turn:1", async (path) =>
    path === "a.ts" ? { content: "two" } : { content: "all" },
  );
  assert.equal(plan.preview.canApply, true);
  assert.deepEqual(plan.restores, []);
  assert.deepEqual(plan.deletes, ["a.ts", "b.ts"]);
});

test("planSuffixFileRewind from a later anchor keeps earlier turns", async () => {
  const rows = [
    header("turn:1"),
    tool("turn:1", "Write", { path: "a.ts", content: "one" }),
    header("turn:2"),
    tool("turn:2", "Write", { path: "b.ts", content: "all" }),
  ];
  const plan = await planSuffixFileRewind(rows, "turn:2", async () => ({ content: "all" }));
  assert.equal(plan.preview.canApply, true);
  assert.deepEqual(plan.deletes, ["b.ts"]);
  assert.deepEqual(suffixTurnIds(rows, "turn:2"), ["turn:2"]);
  assert.deepEqual(suffixTurnIds(rows, "turn:missing"), ["turn:missing"]);
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
  assert.equal(
    header && header.kind === "turnHeader" ? header.actions?.canRewindFiles : false,
    true,
  );
});

test("short execution args do not drop earlier edits from the file count", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        id: "fc_1",
        name: "edit",
        arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "a\nb\nc" }] },
      },
    },
  });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "call|fc_1",
    toolName: "edit",
    args: { path: "a.ts" },
  });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "call|fc_1",
    toolName: "edit",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "c2",
    toolName: "edit",
    args: { path: "b.ts", edits: [{ oldText: "x", newText: "y" }] },
  });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c2",
    toolName: "edit",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  const summary = summarizeTurnFileChanges(
    projector.getSnapshot().rows.window,
    header && header.kind === "turnHeader" ? header.turnId : "",
  );
  assert.equal(summary?.files, 2);
  assert.equal(summary?.items.find((item) => item.path === "a.ts")?.additions, 2);
  assert.equal(header && header.kind === "turnHeader" ? header.fileChanges?.files : 0, 2);
});

test("summarizeTurnFileChanges uses the tool diff when the edit input is empty", () => {
  const row = tool("turn:1", "Edit", { path: "a.ts" });
  const summary = summarizeTurnFileChanges(
    [
      {
        ...row,
        output: {
          text: "ok",
          display: {
            kind: "file_diff",
            filePath: "a.ts",
            additions: 39,
            deletions: 3,
            structuredPatch: [
              { oldStart: 1, oldLines: 3, newStart: 1, newLines: 39, lines: ["-old", "+new"] },
            ],
          },
        },
      },
    ],
    "turn:1",
  );
  assert.equal(summary?.files, 1);
  assert.equal(summary?.additions, 39);
  assert.equal(summary?.deletions, 3);
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
  assert.equal(
    header && header.kind === "turnHeader" ? header.actions?.canRewindFiles : false,
    true,
  );
  projector.markTurnFilesReverted(header && header.kind === "turnHeader" ? header.turnId : "");
  const reverted = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(
    reverted && reverted.kind === "turnHeader" ? reverted.fileChanges?.state : "",
    "reverted",
  );
  assert.equal(
    reverted && reverted.kind === "turnHeader" ? reverted.actions?.canRewindFiles : false,
    undefined,
  );
});

function header(turnId: string): ConversationRow {
  return {
    rowId: 0,
    turnId,
    entityId: `turn:${turnId}`,
    createdAt: 0,
    createdAtSeq: 0,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: 0,
  };
}

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
