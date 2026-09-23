import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { parseFindEntries, quotePosixArg, runSsh, type SshRemoteSpec } from "@zcode/shared/node";
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
  };
}
