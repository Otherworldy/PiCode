type HostStructuredLogLevel = "info" | "warn" | "error";

interface HostStructuredLog {
  level: HostStructuredLogLevel;
  source: string;
  message: string;
}

interface HostLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface RawStreamLog {
  kind: "stdout" | "stderr";
  message: string;
}

interface EmitStructuredLogEntry extends HostStructuredLog {
  timestamp: string;
}

/**
 * host 现在会同时通过 stdout/stderr 和 postMessage 上报日志。
 * 如果 main 两边都立刻写盘，同一条日志会重复出现两次。
 * 这里优先相信结构化的 postMessage；只有 host 在退出前都没发出结构化日志时，
 * 才把早期缓存的 stdout/stderr 当兜底日志回放出来。
 */
export function createHostLogRelay(
  label: string,
  logger: HostLogger,
  emitStructuredLogToRenderer?: (entry: EmitStructuredLogEntry) => void,
) {
  let hasStructuredLog = false;
  const rawLogs: RawStreamLog[] = [];
  /**
   * 兜底日志的容量与刷新节奏。
   *
   * 原来 rawLogs 只在 host 进程退出时（desktopHostProcess 的唯一一处 flushRawLogs）回放，
   * 于是 host 存活期间每条裸 stdout/stderr 都留在内存里：既是无界增长，又意味着崩溃时这批
   * 日志反而全部丢失 —— 恰好在最需要它的时候。
   */
  const MAX_RAW_LOGS = 2000;
  const RAW_LOG_FLUSH_DELAY_MS = 200;
  let rawFlushTimer: NodeJS.Timeout | undefined;

  function flushRawLogsNow(): void {
    if (hasStructuredLog) {
      rawLogs.length = 0;
      return;
    }
    for (const rawLog of rawLogs) emitRawLog(rawLog);
    rawLogs.length = 0;
  }

  function scheduleRawFlush(): void {
    if (rawFlushTimer !== undefined || hasStructuredLog) return;
    rawFlushTimer = setTimeout(() => {
      rawFlushTimer = undefined;
      flushRawLogsNow();
    }, RAW_LOG_FLUSH_DELAY_MS);
    rawFlushTimer.unref?.();
  }

  function appendRawLog(rawLog: RawStreamLog): void {
    rawLogs.push(rawLog);
    // 到量立刻刷，不等定时器：高噪声 host（死循环打日志）不能靠 200ms 窗口兜住。
    if (rawLogs.length >= MAX_RAW_LOGS) {
      if (rawFlushTimer !== undefined) {
        clearTimeout(rawFlushTimer);
        rawFlushTimer = undefined;
      }
      flushRawLogsNow();
      return;
    }
    scheduleRawFlush();
  }

  function emitRawLog(rawLog: RawStreamLog): void {
    if (rawLog.kind === "stderr") {
      if (isNodeWarning(rawLog.message)) {
        logger.warn(`[host-stderr] (${label}):`, formatNodeWarning(rawLog.message));
        return;
      }

      logger.error(`[host-stderr] (${label}):`, rawLog.message);
      return;
    }

    logger.info(`[host-stdout] (${label}):`, rawLog.message);
  }

  function emitStructuredLog(entry: EmitStructuredLogEntry): void {
    const line = `[host-log] (${label}) [${entry.source}] ${entry.message}`;
    if (entry.level === "error") {
      logger.error(line);
      return;
    }

    if (entry.level === "warn") {
      logger.warn(line);
      return;
    }

    logger.info(line);
  }

  return {
    onStdout(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      appendRawLog({ kind: "stdout", message });
    },

    onStderr(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      appendRawLog({ kind: "stderr", message });
    },

    onStructuredLog(entry: HostStructuredLog): void {
      hasStructuredLog = true;
      rawLogs.length = 0;
      if (rawFlushTimer !== undefined) {
        clearTimeout(rawFlushTimer);
        rawFlushTimer = undefined;
      }
      const structuredEntry = {
        ...entry,
        timestamp: new Date().toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      } satisfies EmitStructuredLogEntry;
      emitStructuredLog(structuredEntry);
      emitStructuredLogToRenderer?.(structuredEntry);
    },

    flushRawLogs(): void {
      if (rawFlushTimer !== undefined) {
        clearTimeout(rawFlushTimer);
        rawFlushTimer = undefined;
      }
      flushRawLogsNow();
    },
  };
}

function isNodeWarning(message: string): boolean {
  // Electron utility process 启动早期的 Node warning 只会出现在 stderr。
  // 这类 warning 不是连接失败，兜底回放时应保持 warn 语义，避免远端连接日志被误染成 error。
  return /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u.test(
    message.trimStart(),
  );
}

function formatNodeWarning(message: string): string {
  // Node warning 的第二行通常只是 --trace-warnings 提示，连接页展示它会显得像错误详情。
  // 远端连接日志只保留首行核心 warning，完整排查可通过开发启动参数再开启 trace。
  return message.trimStart().split(/\r?\n/u)[0]?.trimEnd() ?? message.trim();
}
