import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  STORAGE_STARTUP_STALL_TIMEOUT_MS,
  zcodeStorageStartupStateSchema,
  type ZCodeStorageStartupState,
  type DatabaseStartupErrorCode,
} from "@zcode/shared";

const FIRST_STATUS_TIMEOUT_MS = 30_000;

/** 一个 protocol client 对应一个进程代次，状态只来自该连接的合法控制帧。 */
export class ZCodeStorageStartupGate {
  private current?: ZCodeStorageStartupState;
  private terminalError?: Error;
  private pending?: Promise<void>;
  private resolve?: () => void;
  private reject?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly changed = new Emitter<ZCodeStorageStartupState>();
  readonly onDidChange = this.changed.event;

  constructor(
    required: boolean,
    firstStatusTimeoutMs = FIRST_STATUS_TIMEOUT_MS,
    // 可注入是为了让「无进展」路径能被测试覆盖；生产用默认值。
    private readonly stallTimeoutMs = STORAGE_STARTUP_STALL_TIMEOUT_MS,
  ) {
    if (required) {
      this.ensurePending();
      this.timer = setTimeout(() => this.fail("startup_status_timeout"), firstStatusTimeoutMs);
      this.timer.unref?.();
    }
  }

  get isWaiting(): boolean {
    return Boolean(this.terminalError || (this.pending && this.current?.phase !== "ready"));
  }

  /**
   * 是否已经放弃这次启动。
   *
   * `isWaiting` 在失败后仍为 true（用来拒绝后续请求），所以「该不该回收进程」不能只看
   * isWaiting —— 否则失败掉的进程会永远留在内存里。
   */
  get failed(): boolean {
    return Boolean(this.terminalError);
  }

  get snapshot(): ZCodeStorageStartupState | undefined {
    return this.current;
  }

  accept(input: unknown): boolean {
    // dispose 之后的迟到帧不能再改状态：required=false 的 gate 从无 pending，
    // dispose() 不会置 terminalError，不挡住的话会在这里重新装一个看门狗、
    // 让 isWaiting 变回 true，把已经放弃的进程重新算成「还在等」。
    if (this.disposed) return false;
    const parsed = zcodeStorageStartupStateSchema.safeParse(input);
    if (!parsed.success || this.terminalError) return false;
    const next = parsed.data;
    if (
      this.current &&
      (next.attemptId !== this.current.attemptId ||
        next.databaseId !== this.current.databaseId ||
        next.sequence <= this.current.sequence ||
        this.current.phase === "ready" ||
        this.current.phase === "failed")
    )
      return false;
    clearTimeout(this.timer);
    this.current = next;
    if (next.phase === "ready") {
      this.disarmStallTimer();
      this.resolve?.();
    } else if (next.phase === "failed") {
      this.fail(next.errorCode ?? "sql_failed");
    } else {
      // 每个非终态帧都续期：看门狗衡量的是「两次状态帧之间的间隔」。没有它的话，
      // 首帧之后 clearTimeout 就再无出路 —— wait() 永挂、请求超时建不起来、
      // idle 回收也被 isWaiting 挡死。
      this.armStallTimer();
      this.ensurePending();
    }
    this.changed.fire(next);
    return true;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.terminalError) throw this.terminalError;
    if (!this.pending || this.current?.phase === "ready") return;
    if (!signal) return this.pending;
    let abort!: () => void;
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.disarmStallTimer();
    if (this.pending && this.current?.phase !== "ready" && !this.terminalError)
      this.fail("transport_closed");
    this.changed.dispose();
  }

  private armStallTimer(): void {
    this.disarmStallTimer();
    // 等锁期间由下层自己的锁预算负责（tasks/session 库都是 60 分钟），而
    // waiting_for_lock 只上报一次、之后整段等待零帧 —— 在这里继续计时会把
    // 「等锁 60 分钟后报 lock_timeout」改写成「180 秒后报 startup_status_timeout」。
    if (this.current?.phase === "waiting_for_lock") return;
    this.stallTimer = setTimeout(() => this.fail("startup_status_timeout"), this.stallTimeoutMs);
    this.stallTimer.unref?.();
  }

  private disarmStallTimer(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private ensurePending(): void {
    if (this.pending) return;
    this.pending = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // 尚无业务调用时也可能先收到失败；仍保留 rejected promise 给之后的调用者。
    void this.pending.catch(() => undefined);
  }

  private fail(code: DatabaseStartupErrorCode): void {
    this.disarmStallTimer();
    // terminalError 必须在 changed.fire() 之前落位：Emitter 是同步的，监听者
    // （zcodeAgentProcessManager 的 publishStorage）在失败通知里马上读 failed 来决定
    // 是否安排 idle 回收。顺序反了它会读到 failed === false，走进「继续等」分支，
    // 卡死的进程就永远不会被回收 —— 而看门狗恰恰只能走这条路径。
    this.terminalError = new Error(`SQLite startup failed: ${code}`);
    // 首帧之前失败也必须形成快照；未知数据库身份不能伪装成某个已解析路径。
    if (this.current?.phase !== "failed") {
      this.current = this.current
        ? { ...this.current, phase: "failed", errorCode: code, sequence: this.current.sequence + 1 }
        : {
            schemaVersion: 1,
            attemptId: randomUUID(),
            databaseId: `unresolved:${randomUUID()}`,
            databaseKind: "session",
            sequence: 1,
            phase: "failed",
            elapsedMs: 0,
            errorCode: code,
          };
      this.changed.fire(this.current);
    }
    this.reject?.(this.terminalError);
  }
}
