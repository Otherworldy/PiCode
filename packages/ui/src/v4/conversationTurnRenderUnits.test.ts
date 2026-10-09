import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isSeparatelyFoldedFlowItem,
  splitCompactStatusRows,
  type AssistantWorkRow,
} from "./conversationTurnFlowItems.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";

function header(
  state: "running" | "completedSuccess" | "completedInterrupted" | "failed",
): ConversationRow {
  return {
    rowId: 1,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: 1,
    ...(state === "running" ? {} : { endedAt: 10, activeMs: 9 }),
  };
}

function workRows(withText: boolean): ConversationRow[] {
  return [
    {
      rowId: 2,
      turnId: "t1",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "reasoning",
      text: "think",
      state: "complete",
    },
    {
      rowId: 3,
      turnId: "t1",
      createdAt: 3,
      createdAtSeq: 3,
      kind: "toolCall",
      toolCallId: "c1",
      toolName: "Read",
      status: "success",
      inputText: "{}",
    },
    ...(withText
      ? [
          {
            rowId: 4,
            turnId: "t1",
            createdAt: 4,
            createdAtSeq: 4,
            kind: "assistantText" as const,
            text: "done",
            state: "complete" as const,
          },
        ]
      : []),
  ];
}

function historyOpen(rows: ConversationRow[]): boolean {
  const unit = buildConversationTurnRenderUnits(rows)[0];
  return unit?.workSegments?.[0]?.assistantHistoryDefaultOpen === true;
}

test("stopped, failed, and finished turns collapse tools and reasoning", () => {
  assert.equal(historyOpen([header("completedInterrupted"), ...workRows(true)]), false);
  assert.equal(historyOpen([header("completedInterrupted"), ...workRows(false)]), false);
  assert.equal(historyOpen([header("failed"), ...workRows(true)]), false);
  assert.equal(historyOpen([header("completedSuccess"), ...workRows(true)]), false);
  assert.equal(historyOpen([header("completedSuccess"), ...workRows(false)]), false);
});

test("a running turn stays open", () => {
  assert.equal(historyOpen([header("running"), ...workRows(false)]), true);
});

test("trailing compact marker stays outside collapsed work", () => {
  const marker: ConversationRow = {
    rowId: 5,
    turnId: "t1",
    createdAt: 5,
    createdAtSeq: 5,
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: { type: "compact", origin: "manual", status: "running" },
  };
  const unit = buildConversationTurnRenderUnits([
    header("completedSuccess"),
    ...workRows(true),
    marker,
  ])[0];
  assert.equal(
    unit?.assistantTailRows.some((row) => row.rowId === 5),
    true,
  );
  assert.equal(
    unit?.workSegments?.[0]?.assistantFollowingRows.some((row) => row.rowId === 5),
    false,
  );
});

test("blank assistant text does not split consecutive terminal calls", () => {
  const blank = (rowId: number): ConversationRow => ({
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "\n\n",
    state: "complete",
  });
  const bash = (rowId: number): ConversationRow => ({
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `c${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "{}",
  });
  const unit = buildConversationTurnRenderUnits([
    header("running"),
    ...workRows(false),
    blank(4),
    bash(5),
    blank(6),
    bash(7),
  ])[0];
  const folded = unit?.workSegments?.[0]?.flowItems.filter(isSeparatelyFoldedFlowItem) ?? [];
  assert.equal(folded.length, 1);
  const first = folded[0];
  assert.equal(
    first && "rows" in first ? first.rows.filter((row) => row.kind === "toolCall").length : 0,
    3,
  );
});

test("real assistant text still splits the surrounding tools", () => {
  const said = (rowId: number): ConversationRow => ({
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "先看章节",
    state: "complete",
  });
  const bash = (rowId: number): ConversationRow => ({
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `c${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "{}",
  });
  const unit = buildConversationTurnRenderUnits([header("running"), bash(2), said(3), bash(4)])[0];
  const folded = unit?.workSegments?.[0]?.flowItems.filter(isSeparatelyFoldedFlowItem) ?? [];
  assert.equal(folded.length, 2);
});

test("compact status rows stay pinned when folded with tools", () => {
  const tool: ConversationRow = workRows(false)[1]!;
  const marker: ConversationRow = {
    rowId: 5,
    turnId: "t1",
    createdAt: 5,
    createdAtSeq: 5,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: { type: "compact", origin: "manual", status: "success" },
  };
  const groups = splitCompactStatusRows([tool, marker] as AssistantWorkRow[]);
  assert.deepEqual(
    groups.map((group) => [group.pinned, group.rows.map((row) => row.rowId)]),
    [
      [false, [3]],
      [true, [5]],
    ],
  );
});
