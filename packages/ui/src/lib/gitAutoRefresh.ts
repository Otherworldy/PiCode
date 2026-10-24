import type { GitRepositorySummary } from "@zcode/shared";

interface GitAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

export function shouldEnableGitAutoRefreshForWorkspace(params: {
  enabled: boolean;
  currentWorkspaceKey: string;
  summaryWorkspaceKey: string;
}): boolean {
  return params.enabled && params.currentWorkspaceKey === params.summaryWorkspaceKey;
}

// 安静后马上刷。连续写入最多再忍一会儿，避免每个文件一次 git status。
export const GIT_AUTO_REFRESH_QUIET_MS = 1_000;
export const GIT_AUTO_REFRESH_MAX_WAIT_MS = 5_000;
// 只盯 `.git` 时，工作区文件改动不会碰元数据，靠这份轮询让右上角跟上。
export const GIT_AUTO_REFRESH_POLL_MS = 5_000;
export const GIT_AUTO_REFRESH_IGNORED_DIRECTORIES = ["node_modules"] as const;

export function gitAutoRefreshWatchRequest(watchPath: { path: string; recursive: boolean }): {
  path: string;
  recursive: boolean;
  ignoreDirectoryNames: string[];
} {
  return {
    path: watchPath.path,
    recursive: watchPath.recursive,
    ignoreDirectoryNames: [...GIT_AUTO_REFRESH_IGNORED_DIRECTORIES],
  };
}

export function gitAutoRefreshDueAt(params: {
  now: number;
  burstStartedAt: number | null;
  quietMs?: number;
  maxWaitMs?: number;
}): { burstStartedAt: number; dueAt: number } {
  const quietMs = params.quietMs ?? GIT_AUTO_REFRESH_QUIET_MS;
  const maxWaitMs = params.maxWaitMs ?? GIT_AUTO_REFRESH_MAX_WAIT_MS;
  const burstStartedAt = params.burstStartedAt ?? params.now;
  return {
    burstStartedAt,
    dueAt: Math.min(params.now + quietMs, burstStartedAt + maxWaitMs),
  };
}

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

/**
 * 只用于比较的 key：统一分隔符，Windows 盘符/UNC 再抹平大小写。
 *
 * 下发给 `fs.watch` 的路径保持原样 —— POSIX 大小写敏感，不能为了比较去改它。
 */
function watchPathKey(path: string): string {
  const unified = normalizeWatchPath(path).replace(/\\/g, "/");
  return /^(?:[A-Za-z]:|\/\/)/.test(unified) ? unified.toLowerCase() : unified;
}

export function buildGitAutoRefreshWatchPaths(
  summary: Pick<
    GitRepositorySummary,
    "workspacePath" | "repoRoot" | "isGitAvailable" | "isRepository"
  > &
    Partial<Pick<GitRepositorySummary, "autoRefreshWatchPaths">>,
): GitAutoRefreshWatchPath[] {
  if (!summary.isGitAvailable || !summary.isRepository) {
    return [];
  }

  const workspacePath = normalizeWatchPath(summary.workspacePath || summary.repoRoot);
  const watchPaths: GitAutoRefreshWatchPath[] = [];
  for (const watchPath of summary.autoRefreshWatchPaths ?? []) {
    const path = normalizeWatchPath(watchPath.path);
    if (
      !path ||
      // 工作区根永远不进监听，不分平台：`fs.watch(recursive)` 会为整棵目录树挂内核
      // watcher（Windows ReadDirectoryChangesW / macOS FSEvents），node_modules 与
      // 生成目录的每次写入都会回调 Host；忽略名单只能在回调里滤，挡不住通知本身。
      // 工作区内容改动由 GIT_AUTO_REFRESH_POLL_MS 轮询负责。这条同时挡住旧 remote
      // server 仍下发的 workspacePath 递归项。
      watchPathKey(path) === watchPathKey(workspacePath) ||
      watchPaths.some((entry) => entry.path === path)
    ) {
      continue;
    }

    watchPaths.push({
      path,
      recursive: watchPath.recursive,
    });
  }

  return watchPaths;
}

export function shouldPollGitWorkspaceContent(
  watchPaths: readonly GitAutoRefreshWatchPath[],
  workspacePath: string,
): boolean {
  const normalizedWorkspacePath = normalizeWatchPath(workspacePath);
  if (!normalizedWorkspacePath) {
    return false;
  }

  return !watchPaths.some(
    (entry) => entry.recursive && watchPathKey(entry.path) === watchPathKey(normalizedWorkspacePath),
  );
}

export function stringifyGitAutoRefreshWatchPaths(
  watchPaths: readonly GitAutoRefreshWatchPath[],
): string {
  return JSON.stringify(watchPaths);
}

export function parseGitAutoRefreshWatchPaths(signature: string): GitAutoRefreshWatchPath[] {
  const parsed = JSON.parse(signature) as GitAutoRefreshWatchPath[];
  return parsed.map((watchPath) => ({
    path: watchPath.path,
    recursive: Boolean(watchPath.recursive),
  }));
}
