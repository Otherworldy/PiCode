import type { AppUpdateSnapshot } from "@zcode/shared";

export const APP_UPDATE_INITIAL_DELAY_MS = 15_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface AppUpdatePollTarget {
  snapshot: () => AppUpdateSnapshot;
  check: () => Promise<AppUpdateSnapshot>;
  download: () => Promise<AppUpdateSnapshot>;
}

const ACTIVE_PHASES = new Set<AppUpdateSnapshot["phase"]>([
  "checking",
  "downloading",
  "installing",
]);

/** 定时检查只下载，不安装。进行中的检查、下载或安装不会被下一轮打断。已下载的版本仍会复查，版本没变就不会重新下载。 */
export async function pollAppUpdate(target: AppUpdatePollTarget): Promise<void> {
  const phase = target.snapshot().phase;
  if (ACTIVE_PHASES.has(phase)) return;
  const checked = await target.check();
  if (checked.phase === "available") {
    await target.download();
  }
}

export function startAppUpdateScheduler(
  target: AppUpdatePollTarget,
  options: {
    initialDelayMs?: number;
    intervalMs?: number;
    scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
    scheduleInterval?: (callback: () => void, delayMs: number) => () => void;
  } = {},
): () => void {
  let disposed = false;
  let running = false;
  const run = () => {
    if (disposed || running) return;
    running = true;
    void pollAppUpdate(target).finally(() => {
      running = false;
    });
  };
  const scheduleTimeout = options.scheduleTimeout ?? defaultTimeout;
  const scheduleInterval = options.scheduleInterval ?? defaultInterval;
  const cancelTimeout = scheduleTimeout(run, options.initialDelayMs ?? APP_UPDATE_INITIAL_DELAY_MS);
  const cancelInterval = scheduleInterval(run, options.intervalMs ?? APP_UPDATE_CHECK_INTERVAL_MS);
  return () => {
    disposed = true;
    cancelTimeout();
    cancelInterval();
  };
}

function defaultTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function defaultInterval(callback: () => void, delayMs: number): () => void {
  const timer = setInterval(callback, delayMs);
  return () => clearInterval(timer);
}
