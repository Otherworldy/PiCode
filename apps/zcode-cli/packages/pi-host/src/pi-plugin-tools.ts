import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
