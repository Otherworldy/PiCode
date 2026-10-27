import {
  buildAccessScript,
  buildExistsScript,
  buildIsDirectoryExitScript,
  buildIsFileScript,
  buildListNamesScript,
  buildMkdirScript,
  buildReadTextScript,
  buildRemoteCommandScript,
  buildRemoteShellCommand,
  buildRemoveFileScript,
  remoteAgentSystemPromptPath,
  type AgentSystemPromptKind,
  remoteDirname,
  remotePosixPath,
  remoteRootPath,
  writeSshFileContent,
  runSsh,
  spawnSsh,
  sshRemotePlatform,
  type SshRemotePlatform,
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
  // platform 同理：旧 Host 不写这个字段，脏值按 posix 处理，不能让 spec 整体失效。
  if (parsed.platform !== "posix" && parsed.platform !== "windows") {
    delete parsed.platform;
  }
  // Pi 在 Windows 上会把 /root/... resolve 成 C:\root\...。两边都指远端根才算同一个工作区。
  const mapped = remotePosixPath(workspacePath, parsed.remotePath);
  if (!samePath(parsed.remotePath, workspacePath) && !samePath(parsed.remotePath, mapped)) {
    return undefined;
  }
  return parsed;
}

export function sshWorkspacePrompt(spec: SshRemoteSpec): string {
  if (sshRemotePlatform(spec) === "windows") {
    return `This session is an SSH workspace on a remote Windows host. The working directory is ${spec.remotePath}. Commands run in PowerShell. Use Windows paths (for example C:\\Users\\name\\project) and PowerShell cmdlets instead of POSIX tools: use Get-ChildItem instead of ls/find, Get-Content instead of cat, Select-String instead of grep, and New-Item/Remove-Item for file operations.`;
  }
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

/** 按远端平台生成脚本并执行；脚本构造收口在 @zcode/shared/node。 */
async function runRemoteScript(
  spec: SshRemoteSpec,
  build: (platform: SshRemotePlatform) => string,
  options?: { stdin?: Buffer; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const platform = sshRemotePlatform(spec);
  return await runSsh(spec, buildRemoteShellCommand(build(platform), platform), options);
}

async function sshScriptOk(
  spec: SshRemoteSpec,
  build: (platform: SshRemotePlatform) => string,
): Promise<void> {
  const result = await runRemoteScript(spec, build);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
}

async function sshScriptStdout(
  spec: SshRemoteSpec,
  build: (platform: SshRemotePlatform) => string,
): Promise<Buffer> {
  const result = await runRemoteScript(spec, build);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
  return result.stdout;
}

async function writeRemoteFile(spec: SshRemoteSpec, path: string, content: string): Promise<void> {
  await writeSshFileContent(spec, path, content);
}

export async function sshReadText(spec: SshRemoteSpec, remotePath: string): Promise<string> {
  return (
    await sshScriptStdout(spec, (platform) => buildReadTextScript(remotePath, platform))
  ).toString("utf8");
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
  const probe = await sshScriptStdout(spec, (platform) => buildIsFileScript(filePath, platform));
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
  await sshScriptOk(spec, (platform) => buildRemoveFileScript(remotePath, platform));
}

export function sshCodingToolOptions(spec: SshRemoteSpec) {
  const pathOf = (resolved: string) => remotePosixPath(resolved, spec.remotePath);
  return {
    read: {
      operations: {
        readFile: (absolutePath: string) =>
          sshScriptStdout(spec, (platform) => buildReadTextScript(pathOf(absolutePath), platform)),
        access: (absolutePath: string) =>
          sshScriptOk(spec, (platform) =>
            buildAccessScript(pathOf(absolutePath), "read", platform),
          ),
      },
    },
    write: {
      operations: {
        mkdir: (dir: string) =>
          sshScriptOk(spec, (platform) => buildMkdirScript(pathOf(dir), platform)),
        writeFile: (absolutePath: string, content: string) =>
          writeRemoteFile(spec, pathOf(absolutePath), content),
      },
    },
    edit: {
      operations: {
        readFile: (absolutePath: string) =>
          sshScriptStdout(spec, (platform) => buildReadTextScript(pathOf(absolutePath), platform)),
        writeFile: (absolutePath: string, content: string) =>
          writeRemoteFile(spec, pathOf(absolutePath), content),
        access: (absolutePath: string) =>
          sshScriptOk(spec, (platform) =>
            buildAccessScript(pathOf(absolutePath), "readwrite", platform),
          ),
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
          const platform = sshRemotePlatform(spec);
          const remoteCwd = pathOf(cwd);
          // POSIX 远端要把模型照着本机 cwd 写出的盘符路径换回远端根；
          // Windows 远端 cwd 本身就是 Windows 路径，不需要重写。
          const remoteCommand =
            platform === "windows"
              ? buildRemoteCommandScript(command, remoteCwd, platform)
              : buildRemoteCommandScript(rewriteRemoteCommand(command, spec.remotePath), remoteCwd, platform);
          const child = await spawnSsh(
            spec,
            buildRemoteShellCommand(remoteCommand, platform),
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
        exists: async (absolutePath: string) => {
          const output = await sshScriptStdout(spec, (platform) =>
            buildExistsScript([pathOf(absolutePath)], platform),
          );
          return output.toString("utf8").trim() === "1";
        },
        stat: async (absolutePath: string) => {
          const result = await runRemoteScript(spec, (platform) =>
            buildIsDirectoryExitScript(pathOf(absolutePath), platform),
          );
          if (result.code !== 0 && result.code !== 1) {
            throw new Error(result.stderr.trim() || "ssh stat failed");
          }
          const isDirectory = result.code === 0;
          return { isDirectory: () => isDirectory };
        },
        readdir: async (absolutePath: string) => {
          const output = await sshScriptStdout(spec, (platform) =>
            buildListNamesScript(pathOf(absolutePath), platform),
          );
          return output
            .toString("utf8")
            .split("\n")
            .map((name) => name.replace(/\r$/u, ""))
            .filter(Boolean);
        },
      },
    },
  };
}
