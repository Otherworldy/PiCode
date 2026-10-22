import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePrivateTextFile } from "./privateFilePersistence.js";

/** 密码认证目标的最小字段集合；凭据文件按 host/port/user 归档。 */
export interface SshSecretTarget {
  host: string;
  port?: number;
  username: string;
}

export interface SshRemoteSpec extends SshSecretTarget {
  alias?: string;
  remotePath: string;
  /**
   * 密码认证凭据文件（0600，由 Host 写入）。
   *
   * agent spawn env 只下发这个路径而不是密码本身：agent 派生的第三方子进程
   * （MCP server 等）会继承整个 env，密码放 env 等于把长期凭据交给它们。
   */
  passwordFile?: string;
}

const targets = new Map<string, string>();
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const ASKPASS_SECRET_ENV = "ZCODE_SSH_ASKPASS_SECRET";
const SECRET_FILE_EXTENSION = "secret";
/** atomicWritePrivateTextFile 崩溃时可能留下的临时文件；只按时间回收。 */
const STALE_TEMP_FILE_MS = 24 * 60 * 60 * 1000;

export function rememberSshWorkspaceTarget(workspaceIdentity: string, spec: SshRemoteSpec): void {
  targets.set(workspaceIdentity, JSON.stringify(spec));
}

export function forgetSshWorkspaceTarget(workspaceIdentity: string): void {
  targets.delete(workspaceIdentity);
}

export function sshWorkspaceSpawnEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const raw = workspaceIdentity ? targets.get(workspaceIdentity) : undefined;
  return raw ? { ZCODE_SSH_REMOTE: raw } : {};
}

/**
 * 凭据文件按进程隔离：同一台主机可能被多个窗口 Host 同时连接，
 * 关窗时只能删本进程写下的文件，所以 pid 直接进文件名。
 */
function sshSecretKey(target: SshSecretTarget): string {
  return JSON.stringify([
    "ssh-secret:v1",
    target.host.trim().toLowerCase(),
    target.port ?? 22,
    target.username.trim(),
  ]);
}

export function sshPasswordSecretPath(secretDirectory: string, target: SshSecretTarget): string {
  const digest = createHash("sha256").update(sshSecretKey(target)).digest("hex").slice(0, 32);
  return join(secretDirectory, `${digest}.${process.pid}.${SECRET_FILE_EXTENSION}`);
}

const ownedSecretFiles = new Set<string>();
let secretCleanupInstalled = false;

function installSecretCleanup(): void {
  if (secretCleanupInstalled) return;
  secretCleanupInstalled = true;
  process.once("exit", () => {
    for (const filePath of ownedSecretFiles) {
      try {
        unlinkSync(filePath);
      } catch {
        // 退出清理是尽力而为，失败不能让进程反而卡在退出阶段。
      }
    }
    ownedSecretFiles.clear();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但属于其他用户，不能当成已死。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 回收其他 Host 进程遗留的凭据文件。
 *
 * 判据是「属主进程已不存在」而不是时间：窗口可以开好几天，按时间删会把
 * 另一个窗口正在用的凭据删掉，症状是那个窗口突然 Permission denied。
 */
async function sweepStaleSshPasswordSecrets(secretDirectory: string): Promise<void> {
  const names = await readdir(secretDirectory).catch(() => [] as string[]);
  const staleTempDeadline = Date.now() - STALE_TEMP_FILE_MS;
  await Promise.all(
    names.map(async (name) => {
      const filePath = join(secretDirectory, name);
      if (ownedSecretFiles.has(filePath)) return;
      if (name.endsWith(".tmp")) {
        const info = await stat(filePath).catch(() => undefined);
        if (info && info.mtimeMs < staleTempDeadline) {
          await rm(filePath, { force: true }).catch(() => undefined);
        }
        return;
      }
      const owner = /\.(\d+)\.secret$/u.exec(name);
      if (!owner) return;
      const pid = Number(owner[1]);
      if (!Number.isSafeInteger(pid) || pid === process.pid || isProcessAlive(pid)) return;
      await rm(filePath, { force: true }).catch(() => undefined);
    }),
  );
}

/** 写入密码凭据文件，返回 askpass 可读的路径。同一目标重复调用会覆盖同一个文件。 */
export async function writeSshPasswordSecret(
  secretDirectory: string,
  target: SshSecretTarget,
  password: string,
): Promise<string> {
  const filePath = sshPasswordSecretPath(secretDirectory, target);
  // askpass 交给 ssh 的是一行口令，保留结尾换行避免部分实现等不到 EOF。
  await atomicWritePrivateTextFile(filePath, `${password}\n`);
  ownedSecretFiles.add(filePath);
  installSecretCleanup();
  void sweepStaleSshPasswordSecrets(secretDirectory).catch(() => undefined);
  return filePath;
}

export function sshSpecFromConnectTarget(
  target: SshSecretTarget & { sshConfigAlias?: string; password?: string },
  remotePath: string,
  options?: { passwordSecretDirectory?: string },
): SshRemoteSpec {
  const alias = target.sshConfigAlias?.trim();
  const secretDirectory = options?.passwordSecretDirectory;
  // 有密码就是密码认证：系统 ssh 通路不会用 target.privateKeyPath 的 -i，
  // 若这里同时按私钥处理会变成"既没用密码也没用指定私钥"。
  const passwordFile =
    target.password && secretDirectory ? sshPasswordSecretPath(secretDirectory, target) : undefined;
  return {
    host: target.host,
    username: target.username,
    remotePath,
    ...(target.port ? { port: target.port } : {}),
    ...(alias ? { alias } : {}),
    ...(passwordFile ? { passwordFile } : {}),
  };
}

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Pi 在 Windows 上会把远端绝对路径解析成盘符路径。按远端根切回去。 */
export function remotePosixPath(resolved: string, remoteRoot: string): string {
  const root = remoteRoot.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  const normalized = resolved.replaceAll("\\", "/");
  const atRoot = normalized.indexOf(root);
  if (root !== "/" && atRoot >= 0) return normalized.slice(atRoot);
  const stripped = normalized.replace(/^[A-Za-z]:/u, "");
  if (stripped.startsWith("/")) return stripped;
  return `${root}/${stripped.replace(/^\/+/u, "")}`;
}

function sshPasswordFile(spec: SshRemoteSpec): string | undefined {
  const passwordFile = spec.passwordFile?.trim();
  return passwordFile ? passwordFile : undefined;
}

export function sshDestinationArgs(spec: SshRemoteSpec): string[] {
  const hasPassword = sshPasswordFile(spec) !== undefined;
  const args = [
    "-T",
    // 密码认证必须关掉 BatchMode：OpenSSH 会连同密码和 keyboard-interactive 一起禁用。
    "-o",
    hasPassword ? "BatchMode=no" : "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    // 首次连接自动信任并写入 known_hosts（TOFU），指纹变化时仍然拒绝，
    // 所以未登记过的新主机不再直接报 "Host key verification failed."。
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (hasPassword) {
    // 密码模式不先试公钥：部分主机 MaxAuthTries 很小，公钥阶段就会耗尽认证次数。
    // 同时限制重试次数，避免 askpass 反复返回同一个密码把账号打到锁定。
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  const alias = spec.alias?.trim();
  if (alias) {
    args.push(alias);
    return args;
  }
  const port = spec.port ?? 22;
  if (port !== 22) args.push("-p", String(port));
  args.push(`${spec.username}@${spec.host}`);
  return args;
}

interface AskpassScript {
  path: string;
  flavor: "cmd" | "sh";
}

let cachedAskpassFlavor: "cmd" | "sh" | undefined;
let askpassScriptPromise: Promise<AskpassScript> | undefined;

/**
 * 系统 ssh 用 askpass 取密码，askpass 必须是当前 ssh 能直接执行的形态：
 * Windows 原生 OpenSSH 用 .cmd，Git/Cygwin 自带的 ssh 用 POSIX shell 脚本。
 * 靠 `ssh -V` 判定实现而不是猜路径：PortableGit/msys64/scoop shim 等布局猜错时，
 * 症状和密码错误完全一致，线上无法定位。
 */
function resolveAskpassFlavor(): "cmd" | "sh" {
  if (process.platform !== "win32") return "sh";
  if (cachedAskpassFlavor) return cachedAskpassFlavor;
  const probe = spawnSync("ssh", ["-V"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3_000,
  });
  const banner = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  // 探测失败不写缓存：这次拿不到版本不代表下次不行，锁死会让密码认证永久走错形态。
  if (!/OpenSSH_/u.test(banner)) return "sh";
  cachedAskpassFlavor = /OpenSSH_for_Windows/iu.test(banner) ? "cmd" : "sh";
  return cachedAskpassFlavor;
}

/** askpass 脚本内容：只按 env 里的路径读取凭据文件，脚本本身不含口令。 */
export function buildSshAskpassScript(flavor: "cmd" | "sh"): string {
  if (flavor === "cmd") {
    // type 逐字输出凭据文件，避免 cmd 变量展开破坏含 & | % ^ 的密码。
    return `@type "%${ASKPASS_SECRET_ENV}%"\r\n`;
  }
  return `#!/bin/sh\nexec cat "$${ASKPASS_SECRET_ENV}"\n`;
}

/** 脚本不含口令，因此可以按进程复用，不必每条命令重建临时目录。 */
async function resolveAskpassScript(): Promise<AskpassScript> {
  askpassScriptPromise ??= (async (): Promise<AskpassScript> => {
    const flavor = resolveAskpassFlavor();
    const directory = await mkdtemp(join(tmpdir(), "zcode-ssh-askpass-"));
    const path = join(directory, flavor === "cmd" ? "askpass.cmd" : "askpass.sh");
    await writeFile(path, buildSshAskpassScript(flavor), {
      encoding: "utf8",
      ...(flavor === "cmd" ? {} : { mode: 0o700 }),
    });
    return { path, flavor };
  })().catch((error: unknown) => {
    askpassScriptPromise = undefined;
    throw error;
  });
  return await askpassScriptPromise;
}

/** 创建一条远端命令通道；密码认证时注入 askpass 环境，凭据只以文件路径形式经过 env。 */
export async function spawnSsh(
  spec: SshRemoteSpec,
  remoteCommand: string,
  stdio: "pipe" | ["ignore", "pipe", "pipe"] = "pipe",
): Promise<ChildProcess> {
  const passwordFile = sshPasswordFile(spec);
  let env = process.env;
  if (passwordFile) {
    const askpass = await resolveAskpassScript();
    env = {
      ...process.env,
      SSH_ASKPASS: askpass.path,
      SSH_ASKPASS_REQUIRE: "force",
      [ASKPASS_SECRET_ENV]: passwordFile,
      // OpenSSH 8.4 之前只认 DISPLAY + SSH_ASKPASS，保留兼容。
      ...(askpass.flavor === "sh" ? { DISPLAY: process.env["DISPLAY"] ?? "zcode-ssh" } : {}),
    };
  }
  return spawn("ssh", [...sshDestinationArgs(spec), remoteCommand], {
    windowsHide: true,
    stdio,
    env,
  });
}

export function parseFindEntries(
  stdout: string,
  dir: string,
): Array<{ name: string; path: string; type: "file" | "directory"; isSymbolicLink: boolean }> {
  const base = dir.replace(/\/+$/u, "") || "/";
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kind = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (!name || name === "." || name === "..") continue;
    entries.push({
      name,
      path: base === "/" ? `/${name}` : `${base}/${name}`,
      type: kind === "d" ? ("directory" as const) : ("file" as const),
      isSymbolicLink: kind === "l",
    });
  }
  return entries;
}

export async function runSsh(
  spec: SshRemoteSpec,
  remoteCommand: string,
  options?: { stdin?: Buffer; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = await spawnSsh(spec, remoteCommand);
  const out: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let settled = false;
  const kill = () => {
    child.kill();
  };
  options?.signal?.addEventListener("abort", kill, { once: true });
  // 已经 abort 的 signal 不会再触发监听：spawn 之后必须自己补一次。
  if (options?.signal?.aborted) child.kill();
  return await new Promise((resolve, reject) => {
    const finish = (
      error?: Error,
      result?: { code: number | null; stdout: Buffer; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve(result!);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        kill();
        finish(new Error("ssh output exceeded 8 MiB"));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, { code, stdout: Buffer.concat(out), stderr }));
    // ssh 在认证失败/主机密钥变化时会立刻退出，此时写 stdin 会 EPIPE；
    // 不接住这个 error 会变成未捕获异常，直接打崩 Host。
    child.stdin?.on("error", () => undefined);
    if (options?.stdin) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}
