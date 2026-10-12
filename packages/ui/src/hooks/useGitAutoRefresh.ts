import { useEffect, useMemo, useRef, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { GitRepositorySummary } from "@zcode/shared";
import {
  buildGitAutoRefreshWatchPaths,
  GIT_AUTO_REFRESH_POLL_MS,
  gitAutoRefreshDueAt,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  shouldPollGitWorkspaceContent,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";
import { logger } from "@/logger.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

interface GitWatcherRegistration {
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export function useGitAutoRefresh({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  gitSummaryWorkspaceKey,
  enabled,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  gitSummary: GitRepositorySummary;
  gitSummaryWorkspaceKey: string;
  enabled: boolean;
  onRefreshGit: () => void;
}) {
  const workspaceServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const { fileWatcherService, systemService } = workspaceServices;
  const refreshRef = useRef(onRefreshGit);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstStartedAtRef = useRef<number | null>(null);
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const canWatchCurrentWorkspace = shouldEnableGitAutoRefreshForWorkspace({
    enabled,
    currentWorkspaceKey,
    summaryWorkspaceKey: gitSummaryWorkspaceKey,
  });
  const [workspacePlatformState, setWorkspacePlatformState] = useState<{
    service: typeof systemService;
    platform: string;
  } | null>(null);
  // workspaceScopedServices 在远程 workspace 下指向远端 Host，因此这里获取的是
  // WSL/SSH/Docker 的真实运行平台，而不是桌面应用本身的平台。service identity
  // 参与状态匹配，避免 Windows workspace 的旧 platform 泄漏到刚切换的 Linux workspace。
  const workspacePlatform =
    workspacePlatformState?.service === systemService ? workspacePlatformState.platform : null;
  useEffect(() => {
    if (!canWatchCurrentWorkspace || !gitSummary.isGitAvailable || !gitSummary.isRepository) {
      return;
    }

    let cancelled = false;
    void systemService
      .info()
      .then((info) => {
        if (!cancelled) {
          setWorkspacePlatformState({ service: systemService, platform: info.platform });
        }
      })
      .catch(() => {
        // 平台信息不可用时由路径构造器采用 metadata-only 保守策略；手动刷新链路不受影响。
      });

    return () => {
      cancelled = true;
    };
  }, [canWatchCurrentWorkspace, gitSummary.isGitAvailable, gitSummary.isRepository, systemService]);
  const watchPathSignature = useMemo(
    () =>
      stringifyGitAutoRefreshWatchPaths(
        canWatchCurrentWorkspace
          ? buildGitAutoRefreshWatchPaths(
              gitSummary,
              workspacePlatform ? { platform: workspacePlatform } : null,
            )
          : [],
      ),
    [
      canWatchCurrentWorkspace,
      gitSummary.isGitAvailable,
      gitSummary.isRepository,
      gitSummary.repoRoot,
      gitSummary.workspacePath,
      gitSummary.autoRefreshWatchPaths,
      workspacePlatform,
    ],
  );
  const watchPaths = useMemo(
    () => parseGitAutoRefreshWatchPaths(watchPathSignature),
    [watchPathSignature],
  );

  refreshRef.current = onRefreshGit;
  const shouldPollWorkspaceContent =
    canWatchCurrentWorkspace &&
    gitSummary.isGitAvailable &&
    gitSummary.isRepository &&
    shouldPollGitWorkspaceContent(watchPaths, gitSummary.workspacePath || workspacePath);

  useEffect(() => {
    if (!shouldPollWorkspaceContent) {
      return;
    }

    const timer = setInterval(() => {
      refreshRef.current();
    }, GIT_AUTO_REFRESH_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [shouldPollWorkspaceContent]);

  useEffect(() => {
    let cancelled = false;
    const registrations: GitWatcherRegistration[] = [];

    const scheduleRefresh = (path: string) => {
      const now = Date.now();
      const next = gitAutoRefreshDueAt({
        now,
        burstStartedAt: burstStartedAtRef.current,
      });
      burstStartedAtRef.current = next.burstStartedAt;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(
        () => {
          debounceTimerRef.current = null;
          burstStartedAtRef.current = null;
          logger.debug("[GitAutoRefresh] Git 状态变更，刷新仓库状态", {
            workspacePath,
            path,
          });
          refreshRef.current();
        },
        Math.max(0, next.dueAt - now),
      );
    };

    // Git summary 每次刷新都会带回新的 autoRefreshWatchPaths 数组引用。
    // 监听路径内容没变时不能重建 watcher，否则 agent 批量写文件会出现 unwatch/watch 风暴。
    for (const watchPath of watchPaths) {
      void fileWatcherService
        .watch({
          path: watchPath.path,
          recursive: watchPath.recursive,
        })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            scheduleRefresh(event.dirPath);
          });
          registrations.push({
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          // Git 实时刷新只是加速 UI 状态同步；监听失败时保留原有手动刷新和操作后刷新链路。
          logger.warn("[GitAutoRefresh] 监听 Git 工作区失败", {
            workspacePath,
            path: watchPath.path,
            recursive: watchPath.recursive,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      burstStartedAtRef.current = null;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      for (const registration of registrations) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[GitAutoRefresh] 停止监听 Git 工作区失败", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [fileWatcherService, watchPaths, workspacePath]);
}
