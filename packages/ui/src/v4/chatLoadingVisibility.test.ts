import { describe, expect, it } from "vitest";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";

const START = 1_000;

/**
 * 尾窗会把最后一轮的 turnHeader 留在窗口外
 * （docs/specs/conversation-tail-window-turn-header.md）。
 * 这一轮仍在跑时，窗口里剩下的往往全是已落定的行，行级证据不足以判断在跑。
 */
function header(state: TurnHeaderRow["state"]): ConversationRow {
  const row: TurnHeaderRow = {
    rowId: 1,
    turnId: "t1",
    createdAt: START,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: START,
    ...(state === "running" ? {} : { endedAt: START + 10, activeMs: 10 }),
  };
  return row;
}

function settledTool(rowId: number, turnId = "t1"): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: START + rowId * 1_000,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `c${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "echo hi",
    startedAt: START + rowId * 1_000,
    endedAt: START + rowId * 1_000 + 500,
  };
}

/** 后台子代理结果行：backgrounded 不阻塞完成，窗口里只剩它时判不出在跑。 */
function backgroundedTool(rowId: number): ConversationRow {
  return { ...settledTool(rowId), backgrounded: true } as ConversationRow;
}

function lastUnitRunning(
  rows: readonly ConversationRow[],
  sessionPhase: "running" | "completedSuccess" | "completedInterrupted" | "error",
): boolean | undefined {
  return buildConversationTurnRenderUnits(rows, { sessionPhase }).at(-1)?.isRunning;
}

function lastTurnLoading(
  rows: readonly ConversationRow[],
  sessionPhase: "running" | "completedSuccess",
): boolean {
  const units = buildConversationTurnRenderUnits(rows, { sessionPhase });
  const unit = units.at(-1);
  if (!unit) return false;
  return shouldShowTurnChatLoading({
    blockedByActiveWork: false,
    blockedByInteraction: false,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
}

describe("尾窗把 turnHeader 裁掉之后的运行判定", () => {
  it("最后一轮缺 header 且会话相位是 running 时，运行行照常出现", () => {
    const rows = [settledTool(2), backgroundedTool(3)];
    expect(lastUnitRunning(rows, "running")).toBe(true);
    expect(lastTurnLoading(rows, "running")).toBe(true);
  });

  it("同样的行，会话已收口时不出现运行行", () => {
    const rows = [settledTool(2), backgroundedTool(3)];
    expect(lastTurnLoading(rows, "completedSuccess")).toBe(false);
  });

  it("header 仍在窗口内时以 header.state 为准，不被会话相位覆盖", () => {
    // 计划审查、后台子代理收口时 phase 与 header.state 本来就会短暂分叉。
    expect(lastUnitRunning([header("completedSuccess"), settledTool(2)], "running")).toBe(false);
    expect(lastUnitRunning([header("running"), settledTool(2)], "completedSuccess")).toBe(true);
  });

  it("只有最后一轮吃相位兜底，更早的缺 header 轮次不被点亮", () => {
    const earlier = [settledTool(2, "earlier"), settledTool(3, "earlier")];
    const last = [settledTool(4, "last"), settledTool(5, "last")];
    const units = buildConversationTurnRenderUnits([...earlier, ...last], {
      sessionPhase: "running",
    });
    expect(units.map((unit) => unit.isRunning)).toEqual([false, true]);
  });
});
