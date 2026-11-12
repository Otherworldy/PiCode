import type { TurnUsage } from "./rows.js";

/** 解码时间低于这个值就认为不可信，退回总时长（防时钟漂移算成天文数字）。 */
const MIN_DECODE_MS = 100;

/**
 * 这一轮的 prompt 侧总量。Pi 的 `usage.input` 是未缓存输入，
 * `cacheRead` / `cacheWrite` 与之互不相交，三类相加才是发给 provider 的上下文总量。
 */
export function turnPromptTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 卡片标题上的总 token 数。 */
export function turnTotalTokens(usage: TurnUsage): number {
  return turnPromptTokens(usage) + usage.outputTokens;
}

/** 缓存命中率，取值 0–1。没有 prompt 侧 token 时返回 null，不返回 0 假装没命中。 */
export function turnCacheHitRate(usage: TurnUsage): number | null {
  const prompt = turnPromptTokens(usage);
  return prompt > 0 ? usage.cacheReadTokens / prompt : null;
}

/**
 * 吐字速度。只算解码时间：工具执行和等待审批不进分母。
 * 缺总时长时返回 null；输出为 0 也返回 null，不显示 `0 tok/s`。
 */
export function turnTokensPerSecond(usage: TurnUsage): number | null {
  if (usage.outputTokens <= 0) return null;
  const total = usage.llmDurationMs;
  if (total === undefined || total <= 0) return null;
  const decodeMs = total - (usage.ttftMs ?? 0);
  // 总时长来自单调钟，首 token 等待来自墙钟。时钟漂移会把分母缩到几毫秒，
  // 那里算出来是天文数字。分母不足 MIN_DECODE_MS 就当不可信，退回总时长。
  const denominator = decodeMs >= MIN_DECODE_MS ? decodeMs : total;
  return (usage.outputTokens * 1000) / denominator;
}

/**
 * 累加一次模型调用的用量。提供方与模型取最后一次调用：
 * 一轮里换过模型时卡片只显示最后一次，不按调用拆开。
 */
export function addTurnUsage(current: TurnUsage | undefined, next: TurnUsage): TurnUsage {
  if (current === undefined) return next;
  return {
    ...(next.providerId === undefined ? {} : { providerId: next.providerId }),
    ...(next.modelId === undefined ? {} : { modelId: next.modelId }),
    inputTokens: current.inputTokens + next.inputTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + next.cacheWriteTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    // 时长和首 token 等待都要求每一次调用齐全。缺一次就宁可整体不给，
    // 也不拿不完整的分母算出偏快的速度。
    ...(current.llmDurationMs !== undefined && next.llmDurationMs !== undefined
      ? { llmDurationMs: current.llmDurationMs + next.llmDurationMs }
      : {}),
    ...(current.ttftMs !== undefined && next.ttftMs !== undefined
      ? { ttftMs: current.ttftMs + next.ttftMs }
      : {}),
  };
}
