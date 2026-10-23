import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// 启动时确保日志目录存在
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO / dev runner 结束后可能先关闭 stdout/stderr 管道，随后主进程日志还在刷新。
  // stream error 是异步事件，try/catch 包 console.log 不一定兜得住；这里统一吞掉 EPIPE。
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // dev 脚本或父终端退出后，Electron main 的 stdout/stderr 管道可能已关闭。
    // 这时 console.* 会抛 EPIPE，不能让日志输出反过来杀掉主进程；文件日志仍会继续写入。
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 当前打开的日志文件流。
 *
 * 这里原来每行 `mkdirSync` + `appendFileSync`，而 `rpc/logging-middleware` 给每个 RPC 调用
 * 都打一条日志 —— 等于「renderer 每次 RPC」都在主进程 UI 线程上做两次同步文件操作。
 * 换成持久的 WriteStream 后，写入变成一次内存写 + 异步 flush。
 */
let activeLogStream: { filePath: string; stream: WriteStream } | null = null;
/**
 * 落盘失败后的静默窗口。
 *
 * 流出错后复位单槽会让下一行重新 open 文件。持续 ENOSPC / 权限丢失 / 杀软锁文件时，
 * 那就是「每行一次 mkdirSync + createWriteStream」。原来的 appendFileSync 失败也是每行一次
 * open，但那条路径不会反复建目录和分配流对象。这里加一个短窗口，失败后 5s 内只写 console。
 */
const LOG_WRITE_RETRY_DELAY_MS = 5_000;
let logWriteBlockedUntil = 0;

function getLogStream(logDir: string, filePath: string): WriteStream | null {
  if (Date.now() < logWriteBlockedUntil) {
    return null;
  }
  if (activeLogStream?.filePath === filePath) {
    return activeLogStream.stream;
  }
  // 只在切换日志文件（跨日或日志目录变化）时建目录，正常写入路径零调用。
  mkdirSync(logDir, { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a" });
  stream.on("error", () => {
    // 日志写入失败不应影响应用运行，与原 appendFileSync 的 try/catch 等价。
    // 但要复位单槽：留着一个已 destroyed 的流，当天剩余日志会全部静默丢失
    // （原来的 appendFileSync 每次重新 open，一次 ENOSPC/EACCES 之后能自愈）。
    if (activeLogStream?.stream === stream) {
      activeLogStream = null;
    }
    logWriteBlockedUntil = Date.now() + LOG_WRITE_RETRY_DELAY_MS;
  });
  const previous = activeLogStream?.stream;
  activeLogStream = { filePath, stream };
  previous?.end();
  return stream;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}
`;
  const logDir = getLogDir();
  const filePath = join(logDir, `${formatDate(now)}.log`);

  // 同时保留 console 输出，方便开发调试；console 也加时间戳和 PID，与文件格式对齐
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...args);

  try {
    maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
    getLogStream(logDir, filePath)?.write(line);
  } catch {
    // 日志写入失败不应影响应用运行
  }
}

/**
 * main 进程日志，默认写入 ~/.PiCode/v2/logs/YYYY-MM-DD.log；E2E 测试使用 worker 专属目录。
 * 同时保留 console 输出方便开发调试
 */
export const logger = {
  // 高频 browser/CDP 等协议细节只在本地开发记录，避免生产日志量与命令流同数量级。
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** renderer 日志通过 IPC 传入后调用此方法写入同一文件 */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
};
