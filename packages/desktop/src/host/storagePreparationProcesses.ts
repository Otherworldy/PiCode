import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  STORAGE_STARTUP_STALL_TIMEOUT_MS,
  createProgressWatchdog,
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  type DatabaseMigrationFacts,
  databaseStartupErrorDetailsSchema,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    let settled = false;
    // terminate() 抢占不了 worker 里阻塞中的**同步原生调用**（node:sqlite 的 exec/prepare
    // 都是），所以超时/中止不能走「terminate 后等 exit」—— 那条路径可能永不到来，Promise
    // 照样永挂、coordinator.running 照样永真。这里直接结算，代价是可能出现「已 reject 但
    // worker 还没退出、仍持锁」的短窗口（见 docs/specs/startup-stall-watchdog.md）。
    const settleWith = (error: unknown) => {
      if (settled) return;
      settled = true;
      failure = error;
      // 清理也要在这里做：exit 永不到来正是直接结算要覆盖的场景，只靠 exit 处理器
      // 清理的话 watchdog 会再触发一次、abort 监听会残留（3 次 attempt 共用同一 signal）。
      watchdog.dispose();
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      reject(error);
    };
    const watchdog = createProgressWatchdog({
      firstFrameTimeoutMs: 30_000,
      stallTimeoutMs: STORAGE_STARTUP_STALL_TIMEOUT_MS,
      // 等锁期间下层有自己的 60 分钟锁预算，而 waiting_for_lock 只上报一次、之后零帧。
      pausesStall: (phase) => phase === "waiting_for_lock",
      // 保留首因：worker 已经报过 io_error / lock_timeout 时，别让超时把它盖成
      // startup_status_timeout。
      onTimeout: () => settleWith(failure ?? statusError("startup_status_timeout")),
    });
    const abort = () => settleWith(statusError("transport_closed"));
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      if (settled) return;
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        settleWith(statusError("transport_closed"));
        return;
      }
      firstState = true;
      const message = result.data;
      if (message.type === "progress") {
        watchdog.noteFrame(message.phase);
        report(message.phase, message.migration);
      } else if (message.type === "done") {
        watchdog.noteFrame("done");
        done = true;
      } else {
        failure ??= statusError(message.errorCode, message, "tasks-index");
        // failed 也是「有进展」，必须重新武装看门狗：如果上一帧是 paused 的
        // waiting_for_lock，这里不续期的话整条链就再没有任何定时器 —— worker 发出 failed
        // 后卡在同步原生调用里会重新变成永不 settle。
        watchdog.noteFrame(message.type);
      }
    });
    worker.once("error", (error) => {
      // 不再只记 failure：error 之后不保证还有 exit，只靠看门狗兜会晚 180s 才暴露。
      settleWith(error);
    });
    worker.once("exit", (code) => {
      watchdog.dispose();
      signal.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (done && code === 0 && !failure && firstState) resolve();
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

const SESSION_STORAGE_WORKER_ATTEMPTS = 3;
const SESSION_STORAGE_WORKER_RETRY_MS = [300, 1_000];

/** stderr 可能含本机路径；只留短诊断，不把原文路径带进启动失败。 */
export function redactStorageWorkerDiagnostic(text: string): string {
  return text
    .replaceAll("\u0000", "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6)
    .join("\n")
    .replace(/[A-Za-z]:[\\/][^\s'"`)\]]+/g, "[path]")
    .replace(/\/(?:Users|home|tmp|var|opt|usr)\/[^\s'"`)\]]+/g, "[path]")
    .slice(0, 400);
}

/** 还没收到 storagePath 就退出：数据库没打开，同一次启动里再拉起 Worker 不会重复迁移。 */
export function shouldRetrySessionStorageWorker(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { kind?: unknown; code?: unknown; storageWorkerBeforePath?: unknown };
  if (value.storageWorkerBeforePath !== true) return false;
  if (value.kind === "transport_closed") return true;
  return (
    value.code === "EBUSY" ||
    value.code === "EPERM" ||
    value.code === "EACCES" ||
    value.code === "EPIPE" ||
    value.code === "UNKNOWN"
  );
}

function annotateStorageWorkerFailure(
  error: unknown,
  details: {
    /** 缺失表示这次失败不是由退出引起（看门狗超时 / abort），worker 可能仍在跑。 */
    exitCode?: number;
    beforePath: boolean;
    diagnostic: string;
  },
): unknown {
  const failure = error instanceof Error ? error : statusError("transport_closed");
  const summary = details.diagnostic.split("\n")[0] ?? "";
  const exitLabel = details.exitCode === undefined ? "no exit" : `exit ${details.exitCode}`;
  const suffix = summary ? `${exitLabel}: ${summary}` : exitLabel;

  if (!failure.message.includes(suffix)) failure.message = `${failure.message} (${suffix})`;
  return Object.assign(failure, {
    storageWorkerBeforePath: details.beforePath,
    ...(details.exitCode === undefined ? {} : { storageWorkerExitCode: details.exitCode }),
    ...(details.diagnostic ? { storageWorkerDiagnostic: details.diagnostic } : {}),
  });
}

function waitForStorageWorkerRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(statusError("transport_closed"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(statusError("transport_closed"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 在 Host 所属 Worker 运行同一 CLI bundle 的存储入口；Host 退出不会留下持锁孤儿进程。 */
export async function prepareSessionStorage(options: {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const command = resolveDefaultZCodeAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  if (!command?.supportsStorageStartup || !command.storagePreparationEntry)
    throw statusError("unsupported_runtime");
  const entry = command.storagePreparationEntry;
  // 还没打开数据库就退出时可以再拉起，不会重复迁移。
  // 不可写 cwd 上的确定性失败不靠重试；存储准备自己不会去创建项目 .pi。
  for (let attempt = 0; attempt < SESSION_STORAGE_WORKER_ATTEMPTS; attempt += 1) {
    try {
      await runSessionStorageWorker(entry, command, options);
      return;
    } catch (error) {
      if (
        attempt === SESSION_STORAGE_WORKER_ATTEMPTS - 1 ||
        options.signal.aborted ||
        !shouldRetrySessionStorageWorker(error)
      )
        throw error;
      await waitForStorageWorkerRetry(
        SESSION_STORAGE_WORKER_RETRY_MS[attempt] ?? 1_000,
        options.signal,
      );
    }
  }
  throw statusError("transport_closed");
}

function runSessionStorageWorker(
  entry: string,
  command: NonNullable<ReturnType<typeof resolveDefaultZCodeAgentCommand>>,
  options: {
    cwd: string;
    env?: Record<string, string>;
    signal: AbortSignal;
    report: (
      phase: Phase,
      details?: { databaseId: string; migration?: DatabaseMigrationFacts },
    ) => void;
    preparedPaths?: Set<string>;
    observePath: (path: string) => Promise<void>;
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = new Worker(entry, {
      argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", command.cwd ?? options.cwd],
      env: { ...process.env, ...options.env, ...command.env },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    const input = child.stdin!;
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let failure: unknown;
    let stderr = "";
    const terminate = () => {
      void child.terminate();
    };
    // 同 prepareHostStorage：terminate() 抢占不了阻塞中的同步原生调用，必须直接结算，
    // 否则本轮 attempt 永不结束、重试预算也不会推进。
    const settleWith = (error: unknown) => {
      if (settled) return;
      settled = true;
      failure = error;
      watchdog.dispose();
      options.signal.removeEventListener("abort", abort);
      terminate();
      reject(
        annotateStorageWorkerFailure(error, {
          beforePath: !pathReceived,
          diagnostic: redactStorageWorkerDiagnostic(stderr),
        }),
      );
    };
    const abort = () => settleWith(statusError("transport_closed"));
    const watchdog = createProgressWatchdog({
      firstFrameTimeoutMs: 30_000,
      stallTimeoutMs: STORAGE_STARTUP_STALL_TIMEOUT_MS,
      pausesStall: (phase) => phase === "waiting_for_lock",
      onTimeout: () => settleWith(failure ?? statusError("startup_status_timeout")),
    });
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧。stderr 只留一份截断诊断，避免把本机路径推进启动状态。
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= 4096) return;
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    input.on("error", (error) => {
      settleWith(error);
    });
    lines.on("line", (line) => {
      if (settled) return;
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
        if (frame.method === "startup/storagePath") {
          // 进度帧一律续期；等锁阶段由 pausesStall 暂停。
          watchdog.noteFrame("checking");
          if (pathReceived) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            const reuse = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reuse) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted)
              input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          watchdog.noteFrame("ready");
          prepared = pathReceived;
          input.end();
        } else if (frame.params.phase === "failed") {
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
          // 同 prepareHostStorage：failed 帧必须重新武装看门狗，否则上一帧若是 paused 的
          // waiting_for_lock，这里就是整条链最后一个定时器出口。
          watchdog.noteFrame(frame.params.phase);
        } else {
          watchdog.noteFrame(frame.params.phase);
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
        }
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    child.once("error", (error) => {
      settleWith(error);
    });
    child.once("exit", (code) => {
      watchdog.dispose();
      options.signal.removeEventListener("abort", abort);
      const alreadySettled = settled;
      settled = true;
      // 退出事件可能先于最后一行 stdout。等一个 turn，避免把已经写出的失败帧看成失联。
      setImmediate(() => {
        lines.close();
        if (alreadySettled) return;
        if (code === 0 && prepared && !failure) {
          if (preparedPath) options.preparedPaths?.add(preparedPath);
          resolve();
          return;
        }
        reject(
          annotateStorageWorkerFailure(failure ?? statusError("transport_closed"), {
            exitCode: code,
            beforePath: !pathReceived,
            diagnostic: redactStorageWorkerDiagnostic(stderr),
          }),
        );
      });
    });
    if (options.signal.aborted) abort();
  });
}
