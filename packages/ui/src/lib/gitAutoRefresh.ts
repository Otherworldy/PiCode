import type { GitRepositorySummary, SystemInfo } from "@zcode/shared";

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

export function buildGitAutoRefreshWatchPaths(
  summary: Pick<
    GitRepositorySummary,
    "workspacePath" | "repoRoot" | "isGitAvailable" | "isRepository"
  > &
    Partial<Pick<GitRepositorySummary, "autoRefreshWatchPaths">>,
  systemInfo?: Pick<SystemInfo, "platform"> | null,
): GitAutoRefreshWatchPath[] {
  if (!summary.isGitAvailable || !summary.isRepository) {
    return [];
  }

  const workspacePath = normalizeWatchPath(summary.workspacePath || summary.repoRoot);
  const platform = systemInfo?.platform?.trim();
  const canWatchWorkspaceRecursively = Boolean(platform && platform !== "linux");
  const watchPaths: GitAutoRefreshWatchPath[] = [];
  if (workspacePath.length > 0 && canWatchWorkspaceRecursively) {
    watchPaths.push({
      path: workspacePath,
      recursive: true,
    });
  }

  for (const watchPath of summary.autoRefreshWatchPaths ?? []) {
    const path = normalizeWatchPath(watchPath.path);
    if (
      !path ||
      // 兼容旧 remote server：旧 summary 仍可能携带 workspacePath，Linux 下不能让
      // 这个历史字段重新绕过平台边界，触发慢速递归 watcher。
      (path === workspacePath && !canWatchWorkspaceRecursively) ||
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
