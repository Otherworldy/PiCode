export interface FirstFrameClock {
  sessionKey: string | null;
  startedAt: number | null;
  logged: boolean;
}

/** 行第一次进入这次渲染时记下起点。已记过、草稿、或还没有行则不开始。 */
export function markFirstFrameStart(
  clock: FirstFrameClock,
  sessionKey: string,
  rowCount: number,
  now: number,
): FirstFrameClock {
  if (sessionKey === "draft") return clock;
  if (clock.logged && clock.sessionKey === sessionKey) return clock;
  if (clock.sessionKey !== sessionKey) {
    if (rowCount === 0) return { sessionKey, startedAt: null, logged: false };
    return { sessionKey, startedAt: now, logged: false };
  }
  if (clock.logged || rowCount === 0 || clock.startedAt !== null) return clock;
  return { sessionKey, startedAt: now, logged: false };
}

/** layout 时取走首帧耗时。没有起点、已记过、或行还没到则返回 null。 */
export function takeFirstFrameDuration(
  clock: FirstFrameClock,
  sessionKey: string,
  rowCount: number,
  now: number,
): { clock: FirstFrameClock; firstFrameRenderMs: number } | null {
  if (
    sessionKey === "draft" ||
    rowCount === 0 ||
    clock.logged ||
    clock.sessionKey !== sessionKey ||
    clock.startedAt === null
  ) {
    return null;
  }
  return {
    clock: { sessionKey, startedAt: null, logged: true },
    firstFrameRenderMs: Math.max(0, Math.round(now - clock.startedAt)),
  };
}
