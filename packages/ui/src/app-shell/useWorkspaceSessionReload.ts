import { useCallback } from "react";
import { useCurrentSessionReload } from "@/hooks/useCurrentSessionReload.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/picodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function useWorkspaceSessionReload({
  intl,
  workspaceAbsPath,
  reloadSessionDisabled,
}: {
  intl: IntlInstance;
  workspaceAbsPath: string;
  reloadSessionDisabled: boolean;
}) {
  const activeWorkspaceTab = useTabStore((state) => {
    if (!state.activeTabId) return undefined;
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspaceAbsPath)
      return undefined;
    return activeTab;
  });
  const workspaceIdentity = activeWorkspaceTab?.workspaceIdentity;
  const { pending, reload } = useCurrentSessionReload({
    intl,
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: activeWorkspaceTab?.remoteSessionId,
  });
  const handleReloadSession = useCallback(
    async (sessionId: string) => {
      if (reloadSessionDisabled || pending || !sessionId) return;
      const activeTaskId = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath, workspaceIdentity).activeTaskId;
      if (activeTaskId !== sessionId) return;
      await reload(sessionId);
    },
    [pending, reload, reloadSessionDisabled, workspaceAbsPath, workspaceIdentity],
  );

  return {
    reloadSessionPending: pending,
    handleReloadSession,
  };
}
