import { rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { GitCheckpointDiff, GitCheckpointFileDiff } from "@zcode/shared";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  normalizeGitPath,
  toWorkspaceRelativeGitPath,
} from "../config.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";
import { getWorkspaceHash } from "../../paths.js";

interface GitCheckpointNameStatusEntry {
  kind: GitCheckpointFileDiff["kind"];
  path: string;
  originalPath: string | null;
}

interface GitTreeEntry {
  mode: string;
  type: string;
  objectId: string;
  path: string;
}

export function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

export function getWorkspacePathspec(workspaceInRepoPath: string): string {
  return workspaceInRepoPath === "." ? "." : workspaceInRepoPath;
}

export function getCheckpointRefName(workspacePath: string, checkpointId: string): string {
  const workspaceHash = getWorkspaceHash(workspacePath);
  return `refs/zcode/checkpoints/${workspaceHash}/${checkpointId}`;
}

function mapNameStatusKind(status: string): GitCheckpointFileDiff["kind"] {
  const normalized = status[0] ?? "M";
  if (normalized === "A") {
    return "added";
  }
  if (normalized === "D") {
    return "deleted";
  }
  if (normalized === "R" || normalized === "C") {
    return "renamed";
  }
  return "modified";
}

export function parseNameStatus(stdout: string): GitCheckpointNameStatusEntry[] {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitCheckpointNameStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]!;
    const kind = mapNameStatusKind(status);
    if (kind === "renamed") {
      const originalPath = records[index + 1] ?? null;
      const path = records[index + 2] ?? null;
      index += 2;
      if (!originalPath || !path) {
        continue;
      }
      entries.push({
        kind,
        originalPath: normalizeGitPath(originalPath),
        path: normalizeGitPath(path),
      });
      continue;
    }

    const path = records[index + 1] ?? null;
    index += 1;
    if (!path) {
      continue;
    }
    entries.push({
      kind,
      originalPath: null,
      path: normalizeGitPath(path),
    });
  }

  return entries;
}

export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const stats = new Map<string, { added: number; removed: number }>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const fields = record.split("\t");
    if (fields.length < 3) {
      continue;
    }

    const added = fields[0] === "-" ? 0 : Number.parseInt(fields[0] ?? "0", 10) || 0;
    const removed = fields[1] === "-" ? 0 : Number.parseInt(fields[1] ?? "0", 10) || 0;
    const pathField = fields.slice(2).join("\t");
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }

    const originalPath = records[index + 1] ?? "";
    const renamedPath = records[index + 2] ?? "";
    index += 2;
    if (!renamedPath) {
      continue;
    }
    stats.set(normalizeGitPath(renamedPath), { added, removed });
    if (originalPath) {
      stats.set(normalizeGitPath(originalPath), { added, removed });
    }
  }

  return stats;
}

export function parseLsTree(stdout: string): Map<string, GitTreeEntry> {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries = new Map<string, GitTreeEntry>();
  for (const record of records) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) {
      continue;
    }
    const header = record.slice(0, tabIndex).split(" ");
    if (header.length < 3) {
      continue;
    }
    const path = normalizeGitPath(record.slice(tabIndex + 1));
    entries.set(path, {
      mode: header[0] ?? "100644",
      type: header[1] ?? "blob",
      objectId: header[2] ?? "",
      path,
    });
  }
  return entries;
}

export function mergeCheckpointDiff(params: {
  repoRoot: string;
  workspaceInRepoPath: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  nameStatusEntries: GitCheckpointNameStatusEntry[];
  numstat: Map<string, { added: number; removed: number }>;
}): GitCheckpointDiff {
  const files: GitCheckpointFileDiff[] = params.nameStatusEntries.map((entry) => {
    const stat = params.numstat.get(entry.path) ??
      params.numstat.get(entry.originalPath ?? "") ?? {
        added: 0,
        removed: 0,
      };
    return {
      path: toAbsolutePath(params.repoRoot, entry.path),
      repoRelativePath: entry.path,
      workspaceRelativePath: toWorkspaceRelativeGitPath(entry.path, params.workspaceInRepoPath),
      originalPath: entry.originalPath ? toAbsolutePath(params.repoRoot, entry.originalPath) : null,
      kind: entry.kind,
      added: stat.added,
      removed: stat.removed,
    };
  });

  return {
    fromCheckpointId: params.fromCheckpointId,
    toCheckpointId: params.toCheckpointId,
    files,
  };
}

export function buildAffectedRepoPaths(files: GitCheckpointFileDiff[]): string[] {
  const values = new Set<string>();
  for (const file of files) {
    values.add(file.repoRelativePath);
    if (file.originalPath) {
      values.add(file.originalPath);
    }
  }
  return [...values];
}

export function buildCheckpointEnv(tempIndexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: "PiCode Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@zcode.local",
    GIT_COMMITTER_NAME: "PiCode Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@zcode.local",
  };
}

export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, {
    force: true,
    recursive: true,
  });
}

function toRepoRelativePathFromAbsolute(repoRoot: string, absolutePath: string): string {
  return normalizeGitPath(absolutePath.replace(`${repoRoot}${sep}`, ""));
}

export function normalizeAffectedRepoPath(repoRoot: string, path: string): string {
  return normalizeGitPath(isAbsolute(path) ? toRepoRelativePathFromAbsolute(repoRoot, path) : path);
}

const gitCheckpointHashLogger = createServiceLogger("git-checkpoint");

/**
 * `git hash-object --stdin-paths` 读的是「行」而不是纯字节流：
 *
 * - **整行**首字节是 `"` 时，git 会按 C 风格解引用（`unquote_c_style`）；
 * - 行尾 `\r` 会被 `strbuf_getline` 吃掉。
 *
 * 命中这两种情况，git 会去 hash **另一个**路径，而且 exit 0、输出行数不变，
 * 于是「内容已经变了」被静默判成「没变」——restore 随后覆盖掉用户的真实改动。
 *
 * 判的是「整行」：这里入参是绝对路径，Windows 以盘符开头、Unix 以 `/` 开头，
 * 所以首字节是 `"` 的情形只在将来有人传相对路径时才会出现；`\r`/`\n` 则是在 Unix 上
 * 真实可能的文件名。两者都是数据丢失方向的错误，一律挡掉。
 */
function isExpressibleInStdinPathList(absolutePath: string): boolean {
  return !absolutePath.startsWith('"') && !/[\r\n]/.test(absolutePath);
}

/**
 * 批量取 worktree 文件的 blob hash，顺序与输入一致。
 *
 * 逐个 `git hash-object` 在 Windows 上每次 spawn 15-40ms，而且共用按 cwd 的串行 git 队列：
 * 一次 turn 改 100 个文件就是 200 次 spawn（两个调用点各跑一遍），期间同仓库的状态栏、
 * diff、自动刷新全部堵住。`--stdin-paths` 把 N 次排队压成 1 次（实测 60 文件 1719ms → 30ms）。
 *
 * 返回值长度恒等于入参长度。批量不可用时退回逐文件，保持「hash 失败即报错」的原有语义。
 */
export async function hashWorktreeBlobs(
  commandProvider: GitCommandProvider,
  repoRoot: string,
  absolutePaths: string[],
): Promise<string[]> {
  if (absolutePaths.length === 0) {
    return [];
  }

  if (absolutePaths.every(isExpressibleInStdinPathList)) {
    // 输出是每行一个 40 字符 hash，体积与输入规模线性相关。不按规模放宽上限的话，
    // 约 1.3 万个路径就会撞上默认 512KB 截断 → 进程被杀 → 白跑一次再退回串行。
    const maxOutputBytes = Math.max(
      DEFAULT_GIT_OUTPUT_BYTES,
      absolutePaths.length * 64 + 64 * 1024,
    );
    // 整批共用一个超时，按路径数放宽，避免正常的大批量被误判成超时。
    const timeoutMs =
      DEFAULT_GIT_COMMAND_TIMEOUT_MS * Math.max(1, Math.ceil(absolutePaths.length / 500));
    const batch = await commandProvider.run({
      cwd: repoRoot,
      args: ["hash-object", "--no-filters", "--stdin-paths"],
      stdin: `${absolutePaths.join("\n")}\n`,
      maxOutputBytes,
      timeoutMs,
    });

    if (batch.exitCode === 0) {
      const hashes = batch.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (hashes.length === absolutePaths.length) {
        return hashes;
      }
      gitCheckpointHashLogger.warn(
        `批量 hash 输出行数不符，回退逐文件 pathCount=${absolutePaths.length} lineCount=${hashes.length}`,
      );
    } else {
      gitCheckpointHashLogger.warn(
        `批量 hash 失败，回退逐文件 pathCount=${absolutePaths.length} exitCode=${batch.exitCode} timedOut=${batch.timedOut} outputTruncated=${batch.outputTruncated} orphaned=${batch.orphaned} stderr=${batch.stderr.split("\n")[0] ?? ""}`,
      );
    }

    if (batch.orphaned) {
      // 孤儿 git 进程还在跑，队列已被污染：紧接着的逐文件调用会被 previousGitCommandStillRunning
      // 直接判成超时（命令根本没启动），把「上次批量孤儿」误报成「本次 hash 超时」。
      throw new Error(
        "git hash-object batch left an orphaned process; refusing to retry per file",
      );
    }
  }

  const hashes: string[] = [];
  for (const absolutePath of absolutePaths) {
    const single = await commandProvider.run({
      cwd: repoRoot,
      args: ["hash-object", "--no-filters", absolutePath],
    });
    ensureGitCommandSucceeded("git hash-object checkpoint verify", single);
    hashes.push(single.stdout.trim());
  }
  return hashes;
}
