/**
 * 「阶段式等待」的进度看门狗。
 *
 * 这类等待的典型形状是「子进程/worker 报阶段，调用方等终态」。只装一个「首个状态」超时是
 * 不够的：首帧一到就 clearTimeout，之后就再无出路 —— 对端活着但不再推进时 Promise 永久挂起。
 *
 * 这个看门狗提供两个计时器：
 * - `firstFrameTimeoutMs`：首个状态帧之前快速失败（对端没起来）。
 * - `stallTimeoutMs`：两个非终态帧之间的最大间隔，每次 `noteFrame` 续期。
 *
 * `pausesStall` 用于「这个阶段本来就可能长时间没有帧」的情况（例如等数据库锁：下层有自己的
 * 60 分钟锁预算，而 `waiting_for_lock` 只上报一次、之后零帧）。在这些阶段暂停计时，
 * 否则看门狗会把「等锁 60 分钟后报 lock_timeout」改写成「很快报 startup_status_timeout」。
 */
export interface ProgressWatchdogOptions {
  firstFrameTimeoutMs: number;
  stallTimeoutMs: number;
  /** 返回 true 表示该阶段暂停计时（等锁等长等待由下层自己的预算负责）。 */
  pausesStall?: (phase: string) => boolean;
  onTimeout: (reason: "first_frame" | "stall") => void;
}

export interface ProgressWatchdog {
  /** 收到一个状态帧（含终态）。会清掉首帧超时并续期 stall 计时。 */
  noteFrame(phase: string): void;
  /** 停止并清空全部计时器。终态出口必须调用。 */
  dispose(): void;
}

export function createProgressWatchdog(options: ProgressWatchdogOptions): ProgressWatchdog {
  let disposed = false;
  let paused = false;
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const clearStall = () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const armStall = () => {
    clearStall();
    if (disposed || paused) return;
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      if (disposed) return;
      options.onTimeout("stall");
    }, options.stallTimeoutMs);
    stallTimer.unref?.();
  };

  firstFrameTimer = setTimeout(() => {
    firstFrameTimer = undefined;
    if (disposed) return;
    options.onTimeout("first_frame");
  }, options.firstFrameTimeoutMs);
  firstFrameTimer.unref?.();

  return {
    noteFrame(phase: string) {
      if (disposed) return;
      clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      paused = options.pausesStall?.(phase) ?? false;
      armStall();
    },
    dispose() {
      disposed = true;
      clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      clearStall();
    },
  };
}
