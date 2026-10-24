import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { resolveConversationTurnWorkDurationMs } from "@/v4/conversationTurnWorkSegments.js";

/**
 * 只补运行中那一轮的净工时。
 *
 * 放在 `buildConversationTurnRenderUnits` 之外是刻意的：`liveNowMs` 一旦进 builder 的
 * 依赖，每秒都会重建全部 render unit，所有 `memo(ConversationTurnGroup)` 随之失效，
 * 长会话每秒重渲染整部历史。这里对非运行中 unit 返回原引用，bail out 才成立。
 */
export function applyLiveWorkDuration(
  unit: ConversationTurnRenderUnit,
  nowMs: number,
): ConversationTurnRenderUnit {
  if (!unit.isRunning || !unit.workStatus) {
    return unit;
  }
  const durationMs = resolveConversationTurnWorkDurationMs(unit.header, { nowMs }, true);
  // 算不出（controlOnly / 缺 startedAt）或秒数没走到下一格时保持引用不变，
  // 避免 1 Hz 时钟制造无意义的对象与重渲染。
  if (durationMs === undefined || durationMs === unit.workStatus.durationMs) {
    return unit;
  }
  return { ...unit, workStatus: { ...unit.workStatus, durationMs } };
}
