import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import {
  AGENT_PROMPT_MAX_BYTES,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  assertAgentPromptFileName,
  buildExistsScript,
  buildIsFileScript,
  buildListMarkdownScript,
  buildReadRangeScript,
  buildReadTextScript,
  buildReaddirScript,
  buildRemoteShellCommand,
  buildRemoteStartDirectoryScript,
  buildRemoveFileScript,
  buildResolvePathScript,
  buildStatScript,
  normalizeRemoteStartDirectory,
  parseRemoteStat,
  parseFindEntries,
  prepareAgentPromptWrite,
  writeSshFileContent,
  prepareAgentSystemPromptWrite,
  remoteAgentPromptPath,
  remoteAgentPromptsDir,
  remoteAgentSystemPromptPath,
  remoteDirname,
  remoteRootPath,
  runSsh,
  sshRemotePlatform,
  type SshRemotePlatform,
  type SshRemoteSpec,
} from "@zcode/shared/node";
import type { IFileService } from "@zcode/services";

const TEXT_READ_BYTES = 256 * 1024;
/**
 * Windows 侧读片段要 base64 回传，膨胀 1.33 倍后必须低于 runSsh 的 8MiB stdout 上限。
 * 5MiB 留足余量（6MiB 的 base64 正好 8MiB，加上换行会越界）；POSIX 侧不需要。
 */
const WINDOWS_READ_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 远程目录浏览器的起始目录。
 *
 * 以前固定写死 `/home`，在只有 root 的服务器上是空目录。改成探测远端 `$HOME`，
 * 失败时依次退到常见开发目录；任何失败都只影响起始位置，不抛给调用方。
 * Windows 远端取 `%USERPROFILE%`，缺失时退到系统盘根。
 */
export async function resolveRemoteStartDirectory(
  spec: SshRemoteSpec,
  runRemoteCommand: typeof runSsh = runSsh,
): Promise<string> {
  const platform = sshRemotePlatform(spec);
  const result = await runRemoteCommand(
    spec,
    buildRemoteShellCommand(buildRemoteStartDirectoryScript(platform), platform),
  ).catch(() => undefined);
  const raw = result?.code === 0 ? result.stdout.toString("utf8").trim() : "";
  return normalizeRemoteStartDirectory(raw, platform);
}

/**
 * 连接阶段的认证探测。
 *
 * SSH workspace 的 transport 是系统 ssh，连接时只 fork 本地服务、不建立会话，
 * 所以以前认证失败要等目录步骤第一次 readdir 才暴露（界面先报「连接成功」）。
 * 这里在连接阶段跑一条最小远端命令，把认证结果前移到连接步骤。
 * 只用 `echo`：cmd 与 POSIX shell 都有，避免把远端 shell 差异误报成认证失败。
 */
export async function probeSshAuthentication(
  spec: SshRemoteSpec,
  runRemoteCommand: typeof runSsh = runSsh,
): Promise<void> {
  const result = await runRemoteCommand(spec, "echo zcode-ssh-probe");
  if (result.code === 0) return;
  const detail = result.stderr.trim();
  // 系统 ssh 的 stderr 是英文原文，直接展示看不出是认证问题；
  // 这里把认证类错误归一化成产品提示，其余错误保持原文便于排查。
  if (/permission denied|authentication failed/iu.test(detail)) {
    throw new Error(`SSH 认证失败：请检查用户名、密码或私钥配置${detail ? `（${detail}）` : ""}`);
  }
  throw new Error(detail || `ssh exited ${result.code ?? "null"}`);
}

function unsupported(method: string): never {
  throw new Error(`SSH workspace does not support ${method}`);
}

type RemoteRunner = typeof runSsh;

async function sshText(
  spec: SshRemoteSpec,
  remoteCommand: string,
  runRemoteCommand: RemoteRunner = runSsh,
): Promise<string> {
  const result = await runRemoteCommand(spec, remoteCommand);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
  return result.stdout.toString("utf8");
}

/** 按远端平台生成脚本并用对应 shell 执行，返回 stdout 文本。 */
async function sshPlatformScript(
  spec: SshRemoteSpec,
  build: (platform: SshRemotePlatform) => string,
  runRemoteCommand: RemoteRunner = runSsh,
): Promise<string> {
  const platform = sshRemotePlatform(spec);
  return await sshText(spec, buildRemoteShellCommand(build(platform), platform), runRemoteCommand);
}

/**
 * 读取文件片段。
 *
 * POSIX 侧 dd 直接输出原始字节；Windows 侧 PowerShell 输出 base64 再解码，
 * 避免控制台编码改写二进制内容。
 */
async function readRemoteRange(
  spec: SshRemoteSpec,
  path: string,
  offset: number,
  length: number,
  runRemoteCommand: RemoteRunner = runSsh,
): Promise<Buffer> {
  const platform = sshRemotePlatform(spec);
  const requestedLength =
    platform === "windows" ? Math.min(length, WINDOWS_READ_MAX_BYTES) : length;
  const result = await runRemoteCommand(
    spec,
    buildRemoteShellCommand(
      buildReadRangeScript(path, offset, requestedLength, platform),
      platform,
    ),
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "ssh read failed");
  }
  return platform === "windows"
    ? Buffer.from(result.stdout.toString("utf8").trim(), "base64")
    : result.stdout;
}

/** 内容走 stdin 原始字节写远端文件，两侧都不做文本转码。 */
async function writeRemoteText(
  spec: SshRemoteSpec,
  path: string,
  content: string,
  runRemoteCommand: RemoteRunner = runSsh,
): Promise<void> {
  await writeSshFileContent(spec, path, content, runRemoteCommand);
}

async function statRemote(
  spec: SshRemoteSpec,
  path: string,
  runRemoteCommand: RemoteRunner = runSsh,
) {
  return parseRemoteStat(
    await sshPlatformScript(spec, (platform) => buildStatScript(path, platform), runRemoteCommand),
    path,
  );
}

export function createSshFileService(
  spec: SshRemoteSpec,
  runRemoteCommand: RemoteRunner = runSsh,
): IFileService {
  return {
    async searchWorkspaceFiles() {
      return [];
    },
    async readdir(params) {
      const dir = params.path;
      return parseFindEntries(
        await sshPlatformScript(
          spec,
          (platform) => buildReaddirScript(dir, params.includeHidden !== false, platform),
          runRemoteCommand,
        ),
        dir,
        sshRemotePlatform(spec),
      );
    },
    stat(params) {
      return statRemote(spec, params.path, runRemoteCommand);
    },
    async checkFilesExist(params) {
      const lines = (
        await sshPlatformScript(
          spec,
          (platform) => buildExistsScript(params.paths, platform),
          runRemoteCommand,
        )
      )
        .trim()
        .split("\n");
      return params.paths.map((path, index) => ({ path, exists: lines[index]?.trim() === "1" }));
    },
    async resolvePath(params) {
      return (
        await sshPlatformScript(
          spec,
          (platform) => buildResolvePathScript(params.path, platform),
          runRemoteCommand,
        )
      ).trim();
    },
    ensureConversationWorkspace: () => unsupported("ensureConversationWorkspace"),
    createDefaultWorkspace: () => unsupported("createDefaultWorkspace"),
    createScratchWorkspace: () => unsupported("createScratchWorkspace"),
    async readTextFile(params): Promise<FileTextSlice> {
      const fileStat = await statRemote(spec, params.path, runRemoteCommand);
      const offset = Math.max(0, Math.trunc(params.offset ?? 0));
      const length = Math.min(
        TEXT_READ_BYTES,
        Math.max(0, Math.trunc(params.length ?? TEXT_READ_BYTES)),
      );
      if (fileStat.type !== "file" || offset >= (fileStat.size ?? 0)) {
        return {
          path: params.path,
          content: "",
          offset,
          bytesRead: 0,
          totalBytes: fileStat.size ?? 0,
          truncated: false,
          isBinary: false,
        };
      }
      const bytes = await readRemoteRange(spec, params.path, offset, length, runRemoteCommand);
      const isBinary = bytes.includes(0);
      return {
        path: params.path,
        content: isBinary ? "" : bytes.toString("utf8"),
        offset,
        bytesRead: bytes.length,
        totalBytes: fileStat.size ?? offset + bytes.length,
        truncated: offset + bytes.length < (fileStat.size ?? 0),
        isBinary,
      };
    },
    readMediaPreview: (): Promise<FileMediaPreview> => unsupported("readMediaPreview"),
    async readFileRange(params) {
      const bytes = await readRemoteRange(
        spec,
        params.path,
        Math.max(0, Math.trunc(params.offset)),
        Math.max(0, Math.trunc(params.length)),
        runRemoteCommand,
      );
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    readBinaryPreview: (): Promise<FileBinaryPreview> => unsupported("readBinaryPreview"),
    async listWorkspaceFilesLength() {
      return 0;
    },
    async listWorkspaceFilesRange() {
      return "";
    },
    async readWorkspaceFileSearchIgnore() {
      return { content: "", source: "template" as const };
    },
    applyWorkspaceFileSearchIgnoreTransform: () =>
      unsupported("applyWorkspaceFileSearchIgnoreTransform"),
    writeWorkspaceFileSearchIgnore: () => unsupported("writeWorkspaceFileSearchIgnore"),
    async readAgentSystemPrompt(params) {
      // SSH 上的 Agent 仍跑在本机，全局 SYSTEM.md 不在远端。全局只走本机 file service。
      if (params.scope !== "project") unsupported("readAgentSystemPrompt");
      const path = remoteAgentSystemPromptPath(params.rootPath ?? "", params.kind);
      const probe = await sshPlatformScript(
        spec,
        (platform) => buildIsFileScript(path, platform),
        runRemoteCommand,
      );
      if (probe.trim() !== "yes") return { content: "", exists: false, path };
      const fileStat = await statRemote(spec, path, runRemoteCommand);
      if ((fileStat.size ?? 0) > AGENT_SYSTEM_PROMPT_MAX_BYTES) {
        throw new Error("System prompt is too large");
      }
      const text = await sshPlatformScript(
        spec,
        (platform) => buildReadTextScript(path, platform),
        runRemoteCommand,
      );
      return {
        content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
        exists: true,
        path,
      };
    },
    async writeAgentSystemPrompt(params) {
      if (params.scope !== "project") unsupported("writeAgentSystemPrompt");
      const path = remoteAgentSystemPromptPath(params.rootPath ?? "", params.kind);
      const next = prepareAgentSystemPromptWrite(params.content);
      if (next === null) {
        await sshPlatformScript(
          spec,
          (platform) => buildRemoveFileScript(path, platform),
          runRemoteCommand,
        );
        return { content: "", exists: false, path };
      }
      await writeRemoteText(spec, path, next, runRemoteCommand);
      return { content: next, exists: true, path };
    },
    async listAgentPrompts(params) {
      if (params.scope !== "project") unsupported("listAgentPrompts");
      const directory = remoteAgentPromptsDir(params.rootPath ?? "");
      const probe = await sshPlatformScript(
        spec,
        (platform) => buildListMarkdownScript(directory, platform),
        runRemoteCommand,
      );
      const files = probe
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.endsWith(".md") && !name.startsWith("."))
        .filter((name) => {
          try {
            assertAgentPromptFileName(name);
            return true;
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.localeCompare(right));
      return { directory, files };
    },
    async readAgentPrompt(params) {
      if (params.scope !== "project") unsupported("readAgentPrompt");
      const path = remoteAgentPromptPath(params.rootPath ?? "", params.name);
      const fileStat = await statRemote(spec, path, runRemoteCommand);
      if (fileStat.type !== "file") throw new Error(`Path is not a file: ${path}`);
      if ((fileStat.size ?? 0) > AGENT_PROMPT_MAX_BYTES) throw new Error("Prompt is too large");
      const text = await sshPlatformScript(
        spec,
        (platform) => buildReadTextScript(path, platform),
        runRemoteCommand,
      );
      return {
        directory: remoteAgentPromptsDir(params.rootPath ?? ""),
        name: assertAgentPromptFileName(params.name),
        content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      };
    },
    async writeAgentPrompt(params) {
      if (params.scope !== "project") unsupported("writeAgentPrompt");
      const path = remoteAgentPromptPath(params.rootPath ?? "", params.name);
      const content = prepareAgentPromptWrite(params.content);
      const directory = remoteAgentPromptsDir(params.rootPath ?? "");
      await writeRemoteText(spec, path, content, runRemoteCommand);
      return { directory, name: assertAgentPromptFileName(params.name) };
    },
    async deleteAgentPrompt(params) {
      if (params.scope !== "project") unsupported("deleteAgentPrompt");
      const path = remoteAgentPromptPath(params.rootPath ?? "", params.name);
      await sshPlatformScript(
        spec,
        (platform) => buildRemoveFileScript(path, platform),
        runRemoteCommand,
      );
    },
  };
}
