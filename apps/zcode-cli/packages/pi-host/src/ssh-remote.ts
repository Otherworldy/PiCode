import { posix } from "node:path";
import {
  quotePosixArg,
  remoteAgentSystemPromptPath,
  type AgentSystemPromptKind,
  remotePosixPath,
  runSsh,
  spawnSsh,
  type SshRemoteSpec,
} from "@zcode/shared/node";

export type { SshRemoteSpec };

function samePath(left: string, right: string): boolean {
  const norm = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  return norm(left) === norm(right);
}

export function readProcessSshRemoteSpec(workspacePath: string): SshRemoteSpec | undefined {
  const raw = process.env.ZCODE_SSH_REMOTE?.trim();
  if (!raw) return undefined;
  let parsed: SshRemoteSpec;
  try {
    parsed = JSON.parse(raw) as SshRemoteSpec;
  } catch {
    return undefined;
  }
  if (!parsed.host || !parsed.username || !parsed.remotePath) return undefined;
  // env 是跨进程边界，凭据只允许是文件路径。脏值只丢字段，不能让整个 spec
  // 失效——否则远程工作区会静默退化成本地目录，工具开始改本机文件。
  if (typeof parsed.passwordFile !== "string" || parsed.passwordFile.length === 0) {
    delete parsed.passwordFile;
  }
  // Pi 在 Windows 上会把 /root/... resolve 成 C:\root\...。两边都指远端根才算同一个工作区。
  const mapped = remotePosixPath(workspacePath, parsed.remotePath);
  if (!samePath(parsed.remotePath, workspacePath) && !samePath(parsed.remotePath, mapped)) {
    return undefined;
  }
  return parsed;
}

export function sshWorkspacePrompt(spec: SshRemoteSpec): string {
  return `This session is an SSH workspace on a remote POSIX host. The working directory is ${spec.remotePath}. Use POSIX paths and a POSIX shell. Do not use cmd, PowerShell, or Windows drive paths.`;
}

/** 模型跟着 Windows cwd 写出的盘符路径，执行前换回远端 posix。 */
export function rewriteRemoteCommand(command: string, remoteRoot: string): string {
  const root = remoteRoot.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  if (root === "/") return command;
  const body = root
    .slice(1)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", "[\\\\/]");
  return command.replace(new RegExp(`[A-Za-z]:[\\\\/]${body}`, "g"), root);
}

async function sshOk(spec: SshRemoteSpec, remoteCommand: string): Promise<void> {
  const result = await runSsh(spec, remoteCommand);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
}

async function sshStdout(spec: SshRemoteSpec, remoteCommand: string): Promise<Buffer> {
  const result = await runSsh(spec, remoteCommand);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
  return result.stdout;
}

async function writeRemoteFile(spec: SshRemoteSpec, path: string, content: string): Promise<void> {
  const result = await runSsh(
    spec,
    `mkdir -p ${quotePosixArg(posix.dirname(path))} && cat > ${quotePosixArg(path)}`,
    { stdin: Buffer.from(content) },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
}

export async function sshReadText(spec: SshRemoteSpec, remotePath: string): Promise<string> {
  return (await sshStdout(spec, `cat -- ${quotePosixArg(remotePath)}`)).toString("utf8");
}

/**
 * SSH 会话的项目系统提示词在远端 `.pi/SYSTEM.md` 或 `.pi/APPEND_SYSTEM.md`。
 * 文件不存在返回 undefined；存在则返回正文（可以是空字符串）。
 */
export async function readSshProjectSystemPrompt(
  spec: SshRemoteSpec,
  kind: AgentSystemPromptKind = "replace",
): Promise<string | undefined> {
  const filePath = remoteAgentSystemPromptPath(spec.remotePath, kind);
  const probe = await sshStdout(
    spec,
    `if test -f ${quotePosixArg(filePath)}; then printf yes; else printf no; fi`,
  );
  if (probe.toString("utf8").trim() !== "yes") return undefined;
  const text = await sshReadText(spec, filePath);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function sshWriteText(
  spec: SshRemoteSpec,
  remotePath: string,
  content: string,
): Promise<void> {
  await writeRemoteFile(spec, remotePath, content);
}

export async function sshRemoveFile(spec: SshRemoteSpec, remotePath: string): Promise<void> {
  await sshOk(spec, `rm -f -- ${quotePosixArg(remotePath)}`);
}

export function sshCodingToolOptions(spec: SshRemoteSpec) {
  const pathOf = (resolved: string) => remotePosixPath(resolved, spec.remotePath);
  return {
    read: {
      operations: {
        readFile: (absolutePath: string) =>
          sshStdout(spec, `cat -- ${quotePosixArg(pathOf(absolutePath))}`),
        access: (absolutePath: string) => sshOk(spec, `test -r ${quotePosixArg(pathOf(absolutePath))}`),
      },
    },
    write: {
      operations: {
        mkdir: (dir: string) => sshOk(spec, `mkdir -p ${quotePosixArg(pathOf(dir))}`),
        writeFile: (absolutePath: string, content: string) => writeRemoteFile(spec, pathOf(absolutePath), content),
      },
    },
    edit: {
      operations: {
        readFile: (absolutePath: string) =>
          sshStdout(spec, `cat -- ${quotePosixArg(pathOf(absolutePath))}`),
        writeFile: (absolutePath: string, content: string) =>
          writeRemoteFile(spec, pathOf(absolutePath), content),
        access: (absolutePath: string) =>
          sshOk(spec, `test -r ${quotePosixArg(pathOf(absolutePath))} && test -w ${quotePosixArg(pathOf(absolutePath))}`),
      },
    },
    bash: {
      operations: {
        exec: async (
          command: string,
          cwd: string,
          options: {
            onData: (data: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
          },
        ): Promise<{ exitCode: number | null }> => {
          const remoteCwd = pathOf(cwd);
          const remoteCommand = rewriteRemoteCommand(command, spec.remotePath);
          const child = await spawnSsh(
            spec,
            `cd ${quotePosixArg(remoteCwd)} && ${remoteCommand}`,
            ["ignore", "pipe", "pipe"],
          );
          // Pi 的 timeout 单位是秒。当成毫秒会在 SSH 握手前把进程杀掉，退出码是 null。
          const timeoutMs =
            options.timeout && options.timeout > 0 ? options.timeout * 1000 : undefined;
          let timedOut = false;
          return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
            const timer = timeoutMs
              ? setTimeout(() => {
                  timedOut = true;
                  child.kill();
                }, timeoutMs)
              : undefined;
            const onAbort = () => child.kill();
            options.signal?.addEventListener("abort", onAbort, { once: true });
            // 已经 abort 的 signal 不会再回调；spawnSsh 的 await 窗口内点停止必须在这里补杀。
            if (options.signal?.aborted) child.kill();
            const done = (error?: Error, code?: number | null) => {
              if (timer) clearTimeout(timer);
              options.signal?.removeEventListener("abort", onAbort);
              if (timedOut) reject(new Error(`timeout:${options.timeout}`));
              else if (error) reject(error);
              else resolve({ exitCode: code ?? 1 });
            };
            child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
            child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));
            child.on("error", (error) => done(error));
            child.on("close", (code) => done(undefined, code));
          });
        },
      },
    },
    ls: {
      operations: {
        exists: async (absolutePath: string) =>
          (await runSsh(spec, `test -e ${quotePosixArg(pathOf(absolutePath))}`)).code === 0,
        stat: async (absolutePath: string) => {
          const result = await runSsh(spec, `test -d ${quotePosixArg(pathOf(absolutePath))}`);
          if (result.code !== 0 && result.code !== 1) {
            throw new Error(result.stderr.trim() || "ssh stat failed");
          }
          const isDirectory = result.code === 0;
          return { isDirectory: () => isDirectory };
        },
        readdir: async (absolutePath: string) => {
          const result = await runSsh(
            spec,
            `find ${quotePosixArg(pathOf(absolutePath))} -mindepth 1 -maxdepth 1 -printf '%f\\n'`,
          );
          if (result.code !== 0) {
            throw new Error(result.stderr.trim() || "ssh ls failed");
          }
          return result.stdout.toString("utf8").split("\n").filter(Boolean);
        },
      },
    },
  };
}

