import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";
import { isAssistantBodyTextRow } from "@/v4/processEventText.js";

export type AssistantWorkRow = Exclude<ConversationRow, TurnHeaderRow | UserInputRow>;

export type ConversationTurnFlowItem =
  | { kind: "userInput"; row: UserInputRow }
  | { kind: "assistantHistory"; rows: AssistantWorkRow[] }
  | { kind: "assistantText"; row: AssistantTextRow; latest: boolean }
  | {
      kind: "assistantWork";
      rows: AssistantWorkRow[];
      /** inline 不进工作折叠（插件卡、压缩分隔线）。缺省按 following 折叠。 */
      placement?: "following" | "inline";
    }
  | ConversationCuaGroupRenderItem;

/** 正文两侧的工具/思考块。纯压缩行和 inline 不算。 */
export function isSeparatelyFoldedFlowItem(item: ConversationTurnFlowItem): boolean {
  if (item.kind === "assistantHistory") return true;
  if (item.kind === "cuaGroup") return item.flowKind === "assistantHistory";
  if (item.kind !== "assistantWork" || item.placement === "inline") return false;
  return item.rows.some((row) => !isCompactStatusRow(row));
}

/** 最后一个可折叠工具块的位置。中断文案挂在它身上，与后面有没有正文无关。 */
export function lastFoldIndex(flowItems: readonly ConversationTurnFlowItem[]): number {
  for (let index = flowItems.length - 1; index >= 0; index -= 1) {
    const item = flowItems[index];
    if (item && isSeparatelyFoldedFlowItem(item)) return index;
  }
  return -1;
}

/**
 * 只展开仍在进行的最后一块工具区。
 * 段落不再跑，或这一块后面已经有正文，就全部收起。
 */
export function activeWorkingFoldIndex(
  flowItems: readonly ConversationTurnFlowItem[],
  segmentMayStayOpen: boolean,
): number {
  if (!segmentMayStayOpen) return -1;
  const lastFolded = lastFoldIndex(flowItems);
  if (lastFolded < 0) return -1;
  for (let index = lastFolded + 1; index < flowItems.length; index += 1) {
    if (flowItems[index]?.kind === "assistantText") return -1;
  }
  return lastFolded;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function staysOutsideWorkFold(row: AssistantWorkRow): boolean {
  if (row.kind !== "toolCall") return false;
  const name = row.toolName
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  // 问卷收进折叠后会被卸掉，展开前看起来像调用丢了。
  return name === "ask_user_question" || name === "askuserquestion";
}

/** 压缩状态不进「已工作」折叠。跑完的轮默认收起，塞进去就变成没有「正在压缩上下文」。 */
export function isCompactStatusRow(row: AssistantWorkRow): boolean {
  return row.kind === "timelineMarker" && row.marker.type === "compact";
}

export function splitCompactStatusRows(
  rows: readonly AssistantWorkRow[],
): Array<{ pinned: boolean; rows: AssistantWorkRow[] }> {
  const groups: Array<{ pinned: boolean; rows: AssistantWorkRow[] }> = [];
  for (const row of rows) {
    const pinned = isCompactStatusRow(row);
    const last = groups.at(-1);
    if (last?.pinned === pinned) last.rows.push(row);
    else groups.push({ pinned, rows: [row] });
  }
  return groups;
}

function appendGroupedAssistantFlowItem(
  items: ConversationTurnFlowItem[],
  row: AssistantWorkRow,
  placement: "history" | "following" | "inline",
): void {
  const kind = placement === "history" ? "assistantHistory" : "assistantWork";
  const workPlacement = placement === "inline" ? "inline" : "following";
  const previous = items.at(-1);
  if (
    previous?.kind === kind &&
    (previous.kind === "assistantHistory" || previous.placement === workPlacement)
  ) {
    previous.rows.push(row);
    return;
  }
  if (kind === "assistantHistory") items.push({ kind, rows: [row] });
  else items.push({ kind, rows: [row], placement: workPlacement });
}

export function buildConversationFlowItems(options: {
  orderedRows: readonly ConversationRow[];
  assistantHistoryRows: readonly AssistantWorkRow[];
  assistantFollowingRows: readonly AssistantWorkRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  /** 整个 product turn 唯一可挂 action 的最终正文。 */
  latestAssistantTextRow?: AssistantTextRow;
  timelineOnly: boolean;
}): ConversationTurnFlowItem[] {
  const historyRowIds = new Set(options.assistantHistoryRows.map((row) => row.rowId));
  const followingRowIds = new Set(options.assistantFollowingRows.map((row) => row.rowId));
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  const items: ConversationTurnFlowItem[] = [];

  for (const row of options.orderedRows) {
    if (isUserInputRow(row)) {
      items.push({ kind: "userInput", row });
      continue;
    }
    if (!isAssistantWorkRow(row)) continue;
    // 轮尾 boundary 已从 assistant flow 拆成 assistantTailRows；若再把它追加回
    // flowItems，renderer 会把它渲染在定时任务卡片、文件 summary 和消息操作栏之前。
    // 这里只保留真实 flow；boundary 由 TurnGroup 在全部 turn-local 附属 UI 之后统一收尾。
    if (tailRowIds.has(row.rowId)) continue;
    // 正文是折叠边界：中间回复也留在折叠外，把前后工具切成各自的块。
    // process 通知不是正文（`isAssistantBodyTextRow`），它跟在工具后面留在同一块里。
    // 工具回合常带一段 "\n\n"。空白不是正文，切开会让连续终端各自成一块。
    if (isAssistantBodyTextRow(row) && !tailRowIds.has(row.rowId) && !options.timelineOnly) {
      if (!row.text.trim()) continue;
      items.push({
        kind: "assistantText",
        row,
        latest: row.rowId === options.latestAssistantTextRow?.rowId,
      });
      continue;
    }
    const placement = staysOutsideWorkFold(row)
      ? "inline"
      : options.timelineOnly || !historyRowIds.has(row.rowId)
        ? followingRowIds.has(row.rowId)
          ? "following"
          : "inline"
        : "history";
    appendGroupedAssistantFlowItem(items, row, placement);
  }

  return items;
}
