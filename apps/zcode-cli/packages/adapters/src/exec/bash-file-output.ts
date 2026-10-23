import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { buildBashOutputPreview } from "./bash-output-preview.js";
import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { ExecutionStreamResult, ExecutionOutputPreview } from "@zcode/contracts";

const OUTPUT_WATCH_INTERVAL_MS = 5_000;
/** 文件变化触发一次 stat 的合并窗口。 */
const OUTPUT_WATCH_DEBOUNCE_MS = 250;
const OUTPUT_FILE_MODE = 0o600;
const PROGRESS_TAIL_MAX_BYTES = 4096;

/** Bash 只持有文件身份和观察器；原始输出由子进程写入，不经过 Node collector。 */
export class BashFileOutput {
  private handle?: FileHandle;
  private created = false;
  private prepared = false;
  private watchTimer?: NodeJS.Timeout;
  private outputWatcher?: FSWatcher;
  private pendingLimitCheck?: NodeJS.Timeout;
  private unsubscribeProgress?: () => void;
  private progressDelay?: NodeJS.Timeout;

  constructor(
    readonly path: string,
    private readonly platform: NodeJS.Platform,
    private readonly legacyEncoding: string | null,
  ) {}

  get fd(): number | undefined {
    return this.handle?.fd;
  }

  async prepare(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // Windows 的 append-only 句柄被 MSYS 判为只读；Windows 必须用 w。

    const flags =
      this.platform === "win32"
        ? "w"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    this.handle = await open(this.path, flags, OUTPUT_FILE_MODE);
    this.created = existing === undefined;
    this.prepared = true;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    // fd 清理失败不能覆盖取消/退出结果，也不能阻止 adapter 释放其它生命周期资源。
    await handle?.close().catch(() => undefined);
  }

  async discard(): Promise<void> {
    await this.close();
    if (this.created) {
      // 清理失败不能覆盖取消/spawn 的真实结果，也不能删除原有文件。
      await rm(this.path, { force: true }).catch(() => undefined);
    }
    this.prepared = false;
  }

  watchLimit(maxBytes: number, onLimit: () => void): void {
    this.stopWatching();
    const self = this;
    let checking = false;
    const check = (): void => {
      if (checking) return;
      checking = true;
      void stat(self.path)
        .then(
          (file) => {
            // stat 可以在 exit 或后台移交之后才返回；旧观察器不能终止新状态。
            if (self.watchTimer !== timer || file.size <= maxBytes) return;
            self.stopWatching();
            onLimit();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    };
    const timer = setInterval(check, OUTPUT_WATCH_INTERVAL_MS);
    // 子进程直接持有输出文件的 fd，Node 侧没有写入流可计数 —— 唯一的信号是文件大小。
    // 纯 5 秒轮询意味着「超过上限之后」还能继续写最多 5 秒的量；文件变化事件把发现延迟
    // 压到 debounce 窗口，轮询只作为网络盘等不触发 watch 的场景的兜底。
    const scheduleCheck = () => {
      if (self.pendingLimitCheck) return;
      self.pendingLimitCheck = setTimeout(() => {
        self.pendingLimitCheck = undefined;
        check();
      }, OUTPUT_WATCH_DEBOUNCE_MS);
      self.pendingLimitCheck.unref();
    };
    const watcher = watch(this.path, scheduleCheck);
    // watch 失败（权限、文件已被删除）不能影响命令执行，轮询兜底仍然有效。
    watcher.on("error", () => undefined);
    watcher.unref();
    timer.unref();
    this.watchTimer = timer;
    this.outputWatcher = watcher;
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.pendingLimitCheck) clearTimeout(this.pendingLimitCheck);
    this.outputWatcher?.close();
    this.outputWatcher = undefined;
    this.pendingLimitCheck = undefined;
    this.unsubscribeProgress?.();
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.watchTimer = undefined;
    this.unsubscribeProgress = undefined;
    this.progressDelay = undefined;
  }

  watchProgress(
    maxBytes: number,
    delayMs: number,
    intervalMs: number,
    onRead: (output: ExecutionStreamResult, preview: ExecutionOutputPreview) => void,
  ): void {
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.progressDelay = setTimeout(() => {
      this.progressDelay = undefined;
      let previousLines = 0;
      this.unsubscribeProgress = subscribeBashOutputProgress(intervalMs, async (isActive) => {
        const output = await readBashOutput(
          this.path,
          Math.min(maxBytes, PROGRESS_TAIL_MAX_BYTES),
          true,
          this.legacyEncoding,
        );
        // 共享 interval 仍在服务其他任务；取消/重订阅后必须丢弃本订阅迟到的读取。
        if (!isActive()) return;
        const preview = buildBashOutputPreview(
          output.text,
          output.bytesRead,
          output.bytes,
          previousLines,
        );
        previousLines = preview.totalLines;
        onRead(output, preview);
      });
    }, delayMs);
    this.progressDelay.unref();
  }

  async result(maxBytes: number): Promise<ExecutionStreamResult> {
    if (!this.prepared) return { text: "", bytes: 0, truncated: false };
    try {
      const { bytesRead: _bytesRead, ...result } = await readBashOutput(
        this.path,
        maxBytes,
        false,
        this.legacyEncoding,
      );
      return result;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      return {
        text: `<bash output unavailable: output file ${this.path} could not be read (${code}).>`,
        bytes: 0,
        truncated: false,
      };
    }
  }
}

export async function readBashOutput(
  path: string,
  maxBytes: number,
  tail: boolean,
  legacyEncoding: string | null,
): Promise<ExecutionStreamResult & { bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const offset = tail ? size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    return {
      text: decodeExecutionOutputBuffer(buffer.subarray(0, bytesRead), legacyEncoding),
      bytes: size,
      bytesRead,
      truncated: size > bytesRead,
      artifactPath: path,
      artifactBytes: size,
      artifactTruncated: false,
    };
  } finally {
    await handle.close();
  }
}

export async function diagnoseLostBashOutput(outputPath: string): Promise<string | undefined> {
  try {
    const outputDirectory = dirname(outputPath);
    const fileSystem = await statfs(outputDirectory, { bigint: true });
    const availableMegabytes = (fileSystem.bavail * fileSystem.bsize) / (1024n * 1024n);
    const recoveryHint = "Free up space on this filesystem.";
    if (availableMegabytes < 0n) return undefined;
    if (availableMegabytes < 10n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is full (${availableMegabytes}MB free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
    if (fileSystem.files > 0n && fileSystem.ffree < 1000n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is out of inodes (${fileSystem.ffree} free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
  } catch {

  }
  return undefined;
}
