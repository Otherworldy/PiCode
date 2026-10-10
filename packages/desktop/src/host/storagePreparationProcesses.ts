import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
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
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
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
    exitCode: number;
    beforePath: boolean;
    diagnostic: string;
  },
): unknown {
  const failure = error instanceof Error ? error : statusError("transport_closed");
  const summary = details.diagnostic.split("\n")[0] ?? "";
  const suffix = summary ? `exit ${details.exitCode}: ${summary}` : `exit ${details.exitCode}`;

  if (!failure.message.includes(suffix)) failure.message = `${failure.message} (${suffix})`;
  return Object.assign(failure, {
    storageWorkerBeforePath: details.beforePath,
    storageWorkerExitCode: details.exitCode,
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
    const abort = () => {
      failure ??= statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧。stderr 只留一份截断诊断，避免把本机路径推进启动状态。
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= 4096) return;
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    input.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    lines.on("line", (line) => {
      if (settled) return;
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
        clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
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
          prepared = pathReceived;
          input.end();
        } else if (frame.params.phase === "failed")
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
        else
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(firstStateTimer);
      options.signal.removeEventListener("abort", abort);
      // 退出事件可能先于最后一行 stdout。等一个 turn，避免把已经写出的失败帧看成失联。
      setImmediate(() => {
        lines.close();
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
