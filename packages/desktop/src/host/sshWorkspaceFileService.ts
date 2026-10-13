import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import {
  parseFindEntries,
  AGENT_PROMPT_MAX_BYTES,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  assertAgentPromptFileName,
  prepareAgentPromptWrite,
  prepareAgentSystemPromptWrite,
  quotePosixArg,
  remoteAgentPromptPath,
  remoteAgentPromptsDir,
  remoteAgentSystemPromptPath,
  runSsh,
  type SshRemoteSpec,
} from "@zcode/shared/node";
import type { IFileService } from "@zcode/services";

const TEXT_READ_BYTES = 256 * 1024;

function unsupported(method: string): never {
  throw new Error(`SSH workspace does not support ${method}`);
}

async function sshText(spec: SshRemoteSpec, remoteCommand: string): Promise<string> {
  const result = await runSsh(spec, remoteCommand);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `ssh exited ${result.code ?? "null"}`);
  }
  return result.stdout.toString("utf8");
}

async function statRemote(spec: SshRemoteSpec, path: string) {
  const text = await sshText(spec, `stat -c '%F|%s|%Y' -- ${quotePosixArg(path)}`);
  const [kind, size, mtime] = text.trim().split("|");
  return {
    path,
    type: kind === "directory" ? ("directory" as const) : ("file" as const),
    size: Number(size),
    mtimeMs: Number(mtime) * 1000,
  };
}

export function createSshFileService(spec: SshRemoteSpec): IFileService {
  return {
    async searchWorkspaceFiles() {
      return [];
    },
    async readdir(params) {
      const dir = params.path;
      const hidden = params.includeHidden === false ? " ! -name '.*'" : "";
      return parseFindEntries(
        await sshText(spec, `find ${quotePosixArg(dir)} -mindepth 1 -maxdepth 1${hidden} -printf '%y\\t%f\\n'`),
        dir,
      );
    },
    stat(params) {
      return statRemote(spec, params.path);
    },
    async checkFilesExist(params) {
      const script = params.paths
        .map((path) => `if test -e ${quotePosixArg(path)}; then echo 1; else echo 0; fi`)
        .join("; ");
      const lines = (await sshText(spec, script)).trim().split("\n");
      return params.paths.map((path, index) => ({ path, exists: lines[index] === "1" }));
    },
    async resolvePath(params) {
      return (await sshText(spec, `readlink -f -- ${quotePosixArg(params.path)}`)).trim();
    },
    ensureConversationWorkspace: () => unsupported("ensureConversationWorkspace"),
    createDefaultWorkspace: () => unsupported("createDefaultWorkspace"),
    createScratchWorkspace: () => unsupported("createScratchWorkspace"),
    async readTextFile(params): Promise<FileTextSlice> {
      const fileStat = await statRemote(spec, params.path);
      const offset = Math.max(0, Math.trunc(params.offset ?? 0));
      const length = Math.min(TEXT_READ_BYTES, Math.max(0, Math.trunc(params.length ?? TEXT_READ_BYTES)));
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
      const result = await runSsh(
        spec,
        `dd if=${quotePosixArg(params.path)} iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`,
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || "ssh read failed");
      const isBinary = result.stdout.includes(0);
      return {
        path: params.path,
        content: isBinary ? "" : result.stdout.toString("utf8"),
        offset,
        bytesRead: result.stdout.length,
        totalBytes: fileStat.size ?? offset + result.stdout.length,
        truncated: offset + result.stdout.length < (fileStat.size ?? 0),
        isBinary,
      };
    },
    readMediaPreview: (): Promise<FileMediaPreview> => unsupported("readMediaPreview"),
    async readFileRange(params) {
      const result = await runSsh(
        spec,
        `dd if=${quotePosixArg(params.path)} iflag=skip_bytes,count_bytes skip=${Math.max(0, Math.trunc(params.offset))} count=${Math.max(0, Math.trunc(params.length))} status=none`,
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || "ssh read failed");
      return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
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
    applyWorkspaceFileSearchIgnoreTransform: () => unsupported("applyWorkspaceFileSearchIgnoreTransform"),
    writeWorkspaceFileSearchIgnore: () => unsupported("writeWorkspaceFileSearchIgnore"),
    async readAgentSystemPrompt(params) {
      // SSH 上的 Agent 仍跑在本机，全局 SYSTEM.md 不在远端。全局只走本机 file service。
      if (params.scope !== "project") unsupported("readAgentSystemPrompt");
      const path = remoteAgentSystemPromptPath(params.rootPath ?? "", params.kind);
      const probe = await sshText(
        spec,
        `if test -f ${quotePosixArg(path)}; then printf yes; else printf no; fi`,
      );
      if (probe.trim() !== "yes") return { content: "", exists: false, path };
      const fileStat = await statRemote(spec, path);
      if ((fileStat.size ?? 0) > AGENT_SYSTEM_PROMPT_MAX_BYTES) {
        throw new Error("System prompt is too large");
      }
      const text = await sshText(spec, `cat -- ${quotePosixArg(path)}`);
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
        await sshText(spec, `rm -f -- ${quotePosixArg(path)}`);
        return { content: "", exists: false, path };
      }
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      const result = await runSsh(
        spec,
        `mkdir -p ${quotePosixArg(dir)} && cat > ${quotePosixArg(path)}`,
        { stdin: Buffer.from(next, "utf8") },
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "ssh write failed");
      }
      return { content: next, exists: true, path };
    },
    async listAgentPrompts(params) {
      if (params.scope !== "project") unsupported("listAgentPrompts");
      const directory = remoteAgentPromptsDir(params.rootPath ?? "");
      const probe = await sshText(
        spec,
        `if test -d ${quotePosixArg(directory)}; then find ${quotePosixArg(directory)} -mindepth 1 -maxdepth 1 -type f -name '*.md' -printf '%f\n'; fi`,
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
      const fileStat = await statRemote(spec, path);
      if (fileStat.type !== "file") throw new Error(`Path is not a file: ${path}`);
      if ((fileStat.size ?? 0) > AGENT_PROMPT_MAX_BYTES) throw new Error("Prompt is too large");
      const text = await sshText(spec, `cat -- ${quotePosixArg(path)}`);
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
      const result = await runSsh(
        spec,
        `mkdir -p ${quotePosixArg(directory)} && cat > ${quotePosixArg(path)}`,
        { stdin: Buffer.from(content, "utf8") },
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || "ssh write failed");
      return { directory, name: assertAgentPromptFileName(params.name) };
    },
    async deleteAgentPrompt(params) {
      if (params.scope !== "project") unsupported("deleteAgentPrompt");
      const path = remoteAgentPromptPath(params.rootPath ?? "", params.name);
      await sshText(spec, `rm -f -- ${quotePosixArg(path)}`);
    },
  };
}
