import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";

const PROBE_TIMEOUT_MS = 8_000;
const WINDOWS_SHELL_COMMAND = /^(?:npm|pnpm|bun)(?:\.(?:cmd|exe))?$/iu;

export type PiPluginInstallTools = {
  npm: boolean;
  git: boolean;
};

interface ProbeChild {
  kill(): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

type ProbeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ProbeChild;

function needsWindowsShell(command: string): boolean {
  if (process.platform !== "win32") return false;
  const base = command.slice(Math.max(command.lastIndexOf("\\"), command.lastIndexOf("/")) + 1);
  return WINDOWS_SHELL_COMMAND.test(base) || /\.(?:cmd|bat)$/iu.test(base);
}

function quoteCmdArg(arg: string): string {
  return /[\s"&|<>^]/u.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/** 从命令输出里留下能看懂的失败原因。没有可用输出时退回退出码。 */
export function commandFailureText(command: string, code: number, output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^npm ERR!\s*/u, ""))
    .filter(Boolean);
  const interesting = lines.filter((line) =>
    /error|err!|fatal|not found|enoent|eacces|e404|timed out|permission|refused|failed/iu.test(
      line,
    ),
  );
  const text = (interesting.length > 0 ? interesting : lines).slice(-8).join("\n").slice(0, 500);
  return text || `${command} failed with code ${code}`;
}

/**
 * 把非 0 退出变成带输出的 error 事件。
 * `runCommand` 自己只记录退出码；先吞掉 exit，等 stdio 结束后再报错，原因才完整。
 */
export function retainCommandFailure(child: ChildProcess, command: string): void {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-4000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const emit = child.emit.bind(child) as (event: string, ...args: unknown[]) => boolean;
  let pending: number | null = null;
  let reported = false;
  child.emit = ((event: string, ...args: unknown[]) => {
    if (event === "exit" || event === "close") {
      const code = args[0];
      const signal = args[1];
      const failed =
        (typeof code === "number" && code !== 0) || (code == null && Boolean(signal));
      if (event === "exit" && failed) {
        pending = typeof code === "number" ? code : -1;
        return true;
      }
      if (event === "close" && pending !== null && !reported) {
        reported = true;
        return emit("error", new Error(commandFailureText(command, pending, output)));
      }
    }
    return emit(event, ...args);
  }) as typeof child.emit;
}

/** 命令能在 8 秒内以 0 退出才算已安装。找不到或超时都是 false，不抛给设置页。 */
export function commandExitsZero(
  command: string,
  spawnImpl: ProbeSpawn = spawn as ProbeSpawn,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const shell = needsWindowsShell(command);
    let child: ProbeChild;
    try {
      child = spawnImpl(
        shell ? quoteCmdArg(command) : command,
        [shell ? quoteCmdArg("--version") : "--version"],
        {
          env: process.env,
          shell,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

async function configuredPackageManager(cwd: string, agentDir?: string): Promise<string> {
  try {
    await ensurePiSdk();
    const { SettingsManager, getAgentDir } = piCoding();
    const settings = SettingsManager.create(cwd, agentDir ?? getAgentDir());
    const command = settings.getNpmCommand()?.[0]?.trim();
    if (command) return command;
  } catch {
    // 读不到 Pi 设置时按安装器的默认命令探测。
  }
  return "npm";
}

/** 探测安装插件时会调用的包管理器和 git。`npm` 字段表示那条包管理器命令是否可用。 */
export async function probePiPluginInstallTools(
  cwd: string,
  spawnImpl?: ProbeSpawn,
  agentDir?: string,
): Promise<PiPluginInstallTools> {
  const packageManager = await configuredPackageManager(cwd, agentDir);
  const [npm, git] = await Promise.all([
    commandExitsZero(packageManager, spawnImpl),
    commandExitsZero("git", spawnImpl),
  ]);
  return { npm, git };
}

type GitCheckoutScope = "user" | "project";

type GitCheckoutManager = {
  parseSource(source: string): { type: string };
  getGitInstallPath(source: { type: string }, scope: GitCheckoutScope): string;
  getGitInstallRoot(scope: GitCheckoutScope): string | undefined;
};

function isStrictChildPath(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const left = process.platform === "win32" ? target.toLowerCase() : target;
  const right = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  return left.startsWith(right);
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (process.platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

/** 只认这个目录自己的仓库。父目录是仓库时，半截子目录不能算已经装好。 */
function isGitWorkTree(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let stdout = "";
    let child: ChildProcess;
    try {
      child = spawn("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolvePromise(false);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(false);
    }, 8_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0 && samePath(stdout.trim(), dir));
    });
  });
}

function lockedRemove(error: unknown): boolean {
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "ENOTEMPTY";
}

/**
 * Pi 把没有 `.git` 的安装目录当成已有仓库，接着跑 `git rev-parse origin/HEAD` 会报 not a git repository。
 * 只删托管根里面、而且确实不是 git 工作区的半截目录。已经能被 git 认出的检出不动。
 * Windows 上文件被占用时删除会 EPERM，留下目录，不把删不掉当成失败。
 */
export async function removeIncompleteGitCheckout(target: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isStrictChildPath(resolvedRoot, resolvedTarget)) return;
  if (!existsSync(resolvedTarget) || existsSync(join(resolvedTarget, ".git"))) return;
  if (await isGitWorkTree(resolvedTarget)) return;
  try {
    await rm(resolvedTarget, { recursive: true, force: true });
  } catch (error) {
    if (lockedRemove(error)) return;
    throw error;
  }
}

function poisonedGitCheckout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("rev-parse origin/HEAD") && /not a git repository/iu.test(message);
}

function gitCheckoutPaths(
  packages: object,
  source: string,
  scope: GitCheckoutScope,
): { target: string; root: string } | undefined {
  const manager = packages as Partial<GitCheckoutManager>;
  if (
    typeof manager.parseSource !== "function" ||
    typeof manager.getGitInstallPath !== "function" ||
    typeof manager.getGitInstallRoot !== "function"
  ) {
    return undefined;
  }
  const parsed = manager.parseSource(source);
  if (parsed.type !== "git") return undefined;
  const root = manager.getGitInstallRoot(scope);
  if (!root) return undefined;
  return { target: manager.getGitInstallPath(parsed, scope), root };
}

function persistGitSource(packages: object, source: string, scope: GitCheckoutScope): void {
  const manager = packages as {
    addSourceToSettings?(source: string, options?: { local?: boolean }): boolean;
  };
  manager.addSourceToSettings?.(source, scope === "project" ? { local: true } : undefined);
}

function epermOnCheckout(error: unknown, target: string): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll("/", "\\")
    .toLowerCase();
  if (!message.includes("eperm")) return false;
  const normalized = resolve(target).replaceAll("/", "\\").toLowerCase();
  return message.includes(normalized);
}

/**
 * 安装或更新前清掉半截 git 目录。若 Pi 仍因这个原因失败，再清一次并重试。
 * `acceptExisting` 时，目录已经是 git 工作区就只写入设置，不再克隆或删除。
 */
export async function withFreshGitCheckout<T>(
  packages: object,
  source: string,
  scope: GitCheckoutScope,
  run: () => Promise<T>,
  options?: { acceptExisting?: boolean },
): Promise<T> {
  let paths: { target: string; root: string } | undefined;
  try {
    paths = gitCheckoutPaths(packages, source, scope);
    if (options?.acceptExisting && paths && (await isGitWorkTree(paths.target))) {
      persistGitSource(packages, source, scope);
      return undefined as T;
    }
    if (paths) await removeIncompleteGitCheckout(paths.target, paths.root);
  } catch {
    // 算不出托管路径时仍交给 Pi。
  }
  try {
    return await run();
  } catch (error) {
    if (
      options?.acceptExisting &&
      paths &&
      epermOnCheckout(error, paths.target) &&
      (await isGitWorkTree(paths.target))
    ) {
      persistGitSource(packages, source, scope);
      return undefined as T;
    }
    if (!poisonedGitCheckout(error)) throw error;
    try {
      if (paths) await removeIncompleteGitCheckout(paths.target, paths.root);
    } catch {
      // 第二次仍算不出路径，把原来的 git 错误交出去。
    }
    return await run();
  }
}
