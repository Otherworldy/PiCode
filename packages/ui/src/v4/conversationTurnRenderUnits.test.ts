import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
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
