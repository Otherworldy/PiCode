import { create } from "zustand";

function resourceKey(workspacePath: string, workspaceIdentity?: string, sessionId?: string | null) {
  return JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId ?? null]);
}

// 仅用于目录缓存失效；会话运行状态仍由 Host 持有。
export const useSessionResourceStore = create<{
  revisions: Record<string, number>;
  invalidate: (
    workspacePath: string,
    workspaceIdentity: string | undefined,
    sessionId: string,
  ) => void;
}>((set) => ({
  revisions: {},
  invalidate: (workspacePath, workspaceIdentity, sessionId) => {
    const sessionKey = resourceKey(workspacePath, workspaceIdentity, sessionId);
    const workspaceKey = resourceKey(workspacePath, workspaceIdentity);
    set((state) => ({
      revisions: {
        ...state.revisions,
        [sessionKey]: (state.revisions[sessionKey] ?? 0) + 1,
        [workspaceKey]: (state.revisions[workspaceKey] ?? 0) + 1,
      },
    }));
  },
}));

export function useSessionResourceRevision(
  workspacePath: string,
  workspaceIdentity?: string,
  sessionId?: string | null,
): number {
  return useSessionResourceStore(
    (state) => state.revisions[resourceKey(workspacePath, workspaceIdentity, sessionId)] ?? 0,
  );
}
