/**
 * 一轮对话里的阻塞等待时钟：权限审批、`ask_user_question`、hook 审核。
 *
 * `activeMs` 报的是「这个活干了多久」，所以这些等待必须从工时里扣掉。
 * 区间按事件时间戳记录，整轮和每个工作段各自裁剪，不按比例摊销——
 * 折算会让两个视图对不上同一段等待。
 */

export interface TurnWaitClock {
  /** 已结束的等待区间，事件时间戳。 */
  spans: Array<{ startMs: number; endMs: number }>;
  /** 正在进行的那段等待起点；null 表示当前没有阻塞。 */
  openStartedAtMs: number | null;
  /**
   * 正在进行中的等待登记，键是「类型:工具调用 id」。审批、提问、hook 审核可能并发，
   * 所以按请求登记而不是按类型：后到的请求不截断先到的区间。用 toolCallId 而不是
   * requestId，因为 permission_denied 只带 toolCallId；同一 toolCallId 重复发起时
   * 以后到的收口为准，工具终态会兜底收口。
   */
  openKeys: Set<string>;
}

export function createTurnWaitClock(): TurnWaitClock {
  return { spans: [], openStartedAtMs: null, openKeys: new Set() };
}

export function cloneTurnWaitClock(clock: TurnWaitClock): TurnWaitClock {
  return {
    spans: clock.spans.map((span) => ({ ...span })),
    openStartedAtMs: clock.openStartedAtMs,
    openKeys: new Set(clock.openKeys),
  };
}

/**
 * 开始一段阻塞等待。已经有等待在进行时不移动起点：并发等待算一段，
 * 否则后到的请求会把先到请求的等待时间从工时里抹掉。
 */
export function beginWait(clock: TurnWaitClock, atMs: number, key: string): void {
  const wasWaiting = clock.openKeys.size > 0;
  clock.openKeys.add(key);
  if (!wasWaiting) clock.openStartedAtMs = atMs;
}

/**
 * 结束一段阻塞等待。只有所有并发等待都收口后才关闭区间；
 * 没登记过的键直接忽略，避免重复的 resolved/settled 事件凭空造出区段。
 */
export function endWait(clock: TurnWaitClock, atMs: number, key: string): void {
  if (!clock.openKeys.delete(key)) return;
  if (clock.openKeys.size > 0) return;
  const startedAt = clock.openStartedAtMs;
  if (startedAt === null) return;
  const endMs = Math.max(startedAt, atMs);
  // 事件时间戳不保证单调（跨进程时钟、冷恢复合成事件）；与末段重叠时合并，
  // 否则两段相加会把同一段时间扣两次。
  const last = clock.spans.at(-1);
  if (last !== undefined && startedAt <= last.endMs) {
    last.endMs = Math.max(last.endMs, endMs);
    last.startMs = Math.min(last.startMs, startedAt);
  } else {
    clock.spans.push({ startMs: startedAt, endMs });
  }
  clock.openStartedAtMs = null;
}

/**
 * 把等待区间裁剪到 [fromMs, toMs] 后求和。整轮和每个工作段都调它，
 * 所以同一段等待不会被重复扣，也不会因为分段而漏扣。
 */
export function waitedMsIn(clock: TurnWaitClock, fromMs: number, toMs: number): number {
  const closed = closedWaitedMsIn(clock, fromMs, toMs);
  if (clock.openStartedAtMs === null) return closed;
  // 进行中的那段算到 toMs：产出 activeMs 时也要扣，否则秒数会先走再被抹掉。
  return closed + Math.max(0, toMs - Math.max(clock.openStartedAtMs, fromMs));
}

/**
 * 只算已结束的区间。协议上的 `waitedMs` 就是这个含义：进行中的那段由
 * `waitingSince` 单独表达，客户端自己加。混用会把同一段等待扣两次。
 */
export function closedWaitedMsIn(clock: TurnWaitClock, fromMs: number, toMs: number): number {
  let total = 0;
  for (const span of clock.spans) {
    total += Math.max(0, Math.min(span.endMs, toMs) - Math.max(span.startMs, fromMs));
  }
  return total;
}

/** 本轮从开轮到现在累计的等待。拿不到起点时（completion 走 runtimeDuration）用它扣。 */
export function waitedMsForTurn(clock: TurnWaitClock, toMs: number): number {
  const closed = closedWaitedMsIn(clock, 0, toMs);
  if (clock.openStartedAtMs === null) return closed;
  return closed + Math.max(0, toMs - clock.openStartedAtMs);
}

/** 有等待在进行时带上起点；没有就不写这个可选字段。 */
export function waitingSinceField(clock: TurnWaitClock): { waitingSince?: number } {
  return clock.openStartedAtMs === null ? {} : { waitingSince: clock.openStartedAtMs };
}

/** 新轮开始。跨轮的等待不算这一轮的工时。 */
export function resetWaitClock(clock: TurnWaitClock): void {
  clock.spans = [];
  clock.openStartedAtMs = null;
  clock.openKeys.clear();
}
