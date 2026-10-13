import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import {
  createGitEnvironmentProvider,
  type GitEnvironmentProvider,
} from "./gitEnvironmentProvider.js";

export interface GitCommandExecutionOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitCommandExecutionResult {
  binaryPath: string;
  cwd: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  timeoutMs?: number;
  timeoutElapsedMs?: number;
  timeoutCloseDelayMs?: number;
  forceKillAttempted?: boolean;
  orphaned?: boolean;
  outputTruncated: boolean;
}

export interface GitCommandProvider {
  resolveGitBinary(): Promise<string | null>;
  run(options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult>;
}

const DEFAULT_TIMEOUT_KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS = 2_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function forceKillChildProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform === "win32" && typeof child.pid === "number") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
    };
    killer.once("error", cleanup);
    killer.once("close", cleanup);
    return;
  }

  child.kill("SIGKILL");
}

interface LiveGitCommand {
  exited: boolean;
  killTree: () => void;
}

// 同一个 cwd 的 git 共用一条队列。并行 status/diff 会同时把大仓库 index 扫进内存。
const gitCommandChains = new Map<string, Promise<void>>();
const liveGitCommands = new Map<string, LiveGitCommand>();

function enqueueGitCommand<T>(cwd: string, job: () => Promise<T>): Promise<T> {
  const previous = gitCommandChains.get(cwd) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settledPrevious = previous.then(
    () => undefined,
    () => undefined,
  );
  gitCommandChains.set(
    cwd,
    settledPrevious.then(() => gate),
  );
  return settledPrevious.then(job).finally(release);
}

async function previousGitCommandStillRunning(cwd: string, graceMs: number): Promise<boolean> {
  const live = liveGitCommands.get(cwd);
  if (!live || live.exited) {
    return false;
  }

  live.killTree();
  await wait(graceMs);
  return !live.exited;
}

export function createGitCommandProvider(options?: {
  environmentProvider?: GitEnvironmentProvider;
  platform?: NodeJS.Platform;
  timeoutKillGraceMs?: number;
  timeoutForceKillGraceMs?: number;
}): GitCommandProvider {
  const environmentProvider = options?.environmentProvider ?? createGitEnvironmentProvider();
  const platform = options?.platform ?? process.platform;
  const timeoutKillGraceMs = options?.timeoutKillGraceMs ?? DEFAULT_TIMEOUT_KILL_GRACE_MS;
  const timeoutForceKillGraceMs =
    options?.timeoutForceKillGraceMs ?? DEFAULT_TIMEOUT_FORCE_KILL_GRACE_MS;

  return {
    async resolveGitBinary(): Promise<string | null> {
      return await environmentProvider.resolveGitBinary();
    },

    async run(command: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> {
      const gitBinary = await environmentProvider.resolveGitBinary();
      if (!gitBinary) {
        throw new Error("Git binary is not available");
      }
      const binaryPath = gitBinary;

      const timeoutMs = command.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
      const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
      const env = {
        ...environmentProvider.createCommandEnv(),
        ...command.env,
      };
      const startedAt = Date.now();

      return enqueueGitCommand(command.cwd, async () => {
        if (await previousGitCommandStillRunning(command.cwd, timeoutForceKillGraceMs)) {
          return {
            binaryPath,
            cwd: command.cwd,
            args: command.args,
            stdout: "",
            stderr: "previous git command is still running",
            exitCode: null,
            signal: null,
            durationMs: Date.now() - startedAt,
            timedOut: true,
            timeoutMs,
            forceKillAttempted: true,
            orphaned: true,
            outputTruncated: false,
          };
        }

        return await new Promise<GitCommandExecutionResult>((resolve) => {
          let stdout = "";
          let stderr = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let timedOut = false;
          let timeoutElapsedMs: number | undefined;
          let forceKillAttempted = false;
          let orphaned = false;
          let outputTruncated = false;
          let settled = false;

          const child = spawn(binaryPath, command.args, {
            cwd: command.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          const liveCommand: LiveGitCommand = {
            exited: false,
            killTree: () => {
              forceKillAttempted = true;
              forceKillChildProcess(child, platform);
            },
          };
          liveGitCommands.set(command.cwd, liveCommand);
          // close 可能被超时清理摘掉。exit 才表示进程真的没了，队列才能再起下一个。
          child.once("exit", () => {
            liveCommand.exited = true;
          });

          function buildResult(
            exitCode: number | null,
            signal: NodeJS.Signals | null,
          ): GitCommandExecutionResult {
            const durationMs = Date.now() - startedAt;
            return {
              binaryPath,
              cwd: command.cwd,
              args: command.args,
              stdout,
              stderr,
              exitCode,
              signal,
              durationMs,
              timedOut,
              timeoutMs,
              timeoutElapsedMs,
              timeoutCloseDelayMs:
                timedOut && timeoutElapsedMs !== undefined
                  ? Math.max(durationMs - timeoutElapsedMs, 0)
                  : undefined,
              forceKillAttempted,
              orphaned,
              outputTruncated,
            };
          }

          function settle(result: GitCommandExecutionResult): void {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            child.stdout?.off("data", appendStdoutChunk);
            child.stderr?.off("data", appendStderrChunk);
            child.removeAllListeners("error");
            child.removeAllListeners("close");
            if (result.orphaned) {
              // Windows 上 Git helper/filter 可能拖住 stdout/stderr 句柄，
              // 如果超时后仍未 close，先断开本进程对管道和子进程句柄的引用，避免 checkpoint 继续卡住主链路。
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
            }
            resolve(result);
          }

          async function handleTimeout(): Promise<void> {
            if (settled) {
              return;
            }
            timedOut = true;
            timeoutElapsedMs = Date.now() - startedAt;
            liveCommand.killTree();

            await wait(timeoutKillGraceMs);
            if (settled) {
              return;
            }

            liveCommand.killTree();

            await wait(timeoutForceKillGraceMs);
            if (settled) {
              return;
            }

            orphaned = true;
            settle(buildResult(null, null));
          }

          const timer = setTimeout(() => {
            void handleTimeout();
          }, timeoutMs);

          const appendChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
            if (outputTruncated) {
              return;
            }

            const byteLength = chunk.byteLength;
            const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
            if (currentBytes + byteLength > maxOutputBytes) {
              outputTruncated = true;
              // 超限后 git 仍会继续把整个工作区扫进内存。立刻杀掉进程树，不等超时。
              liveCommand.killTree();
              child.stdout?.on("error", () => {});
              child.stderr?.on("error", () => {});
              child.stdout?.destroy();
              child.stderr?.destroy();
              return;
            }

            const text = chunk.toString("utf-8");
            if (target === "stdout") {
              stdout += text;
              stdoutBytes += byteLength;
            } else {
              stderr += text;
              stderrBytes += byteLength;
            }
          };

          const appendStdoutChunk = (chunk: Buffer) => appendChunk(chunk, "stdout");
          const appendStderrChunk = (chunk: Buffer) => appendChunk(chunk, "stderr");

          child.once("error", (error) => {
            // 当 cwd 被并发删除或运行环境瞬时缺失 git 时，spawn 会直接抛错进入 "error" 事件。
            // 之前这里 reject 会在某些 fire-and-forget 调用链里变成 unhandled rejection，
            // 进而让 Vitest 出现整批超时假红。这里统一降级为“命令失败结果”，
            // 由上层按既有 ensureGitCommandSucceeded 语义处理，避免把异常泄漏成进程级未捕获拒绝。
            stderr = error instanceof Error ? error.message : String(error);
            settle(buildResult(-2, null));
          });
          child.stdout?.on("data", appendStdoutChunk);
          child.stderr?.on("data", appendStderrChunk);
          child.once("close", (exitCode, signal) => {
            settle(buildResult(exitCode, signal));
          });
        });
      });
    },
  };
}
