import { useShallow } from "zustand/react/shallow";
import {
  getWorkspaceDisplayedTaskState,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
  type WorkspaceZCodeUIState,
} from "@/store/picodeSessionStore.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { hasBusyTaskInWorkspaceProvider } from "@/lib/workspaceBusyTaskLock.js";

type WorkspaceShellZCodeState = Pick<
  WorkspaceZCodeUIState,
  | "activeTaskId"
  | "draftFocusVersion"
  | "modelSwitchPending"
  | "modelSwitchStage"
  | "selectedProvider"
  | "selectedSupplierKey"
  | "configOptions"
  | "optimisticTaskListByTaskId"
  | "workspaceInit"
> &
  ReturnType<typeof getWorkspaceDisplayedTaskState>;

export function useWorkspaceShellZCodeState(workspaceAbsPath: string, workspaceIdentity?: string) {
  // App 之前直接订阅整个 workspaceZCodeState，streaming 每个 chunk 都会改 taskMessagesByTaskId。
  // 这会把侧边栏、Header、Git 派生逻辑一起拖进同步重渲染，性能 trace 里那串 long task 就是这样被放大的。
  // 这里把外壳真正依赖的字段收敛成浅比较选择器，避免消息流惊动无关 UI。
  const workspaceShellZCodeState = useZCodeSessionStore(
    useShallow((state): WorkspaceShellZCodeState => {
      const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
      const displayedTaskState = getWorkspaceDisplayedTaskState(workspaceState);
      return {
        activeTaskId: workspaceState.activeTaskId,
        draftFocusVersion: workspaceState.draftFocusVersion,
        modelSwitchPending: workspaceState.modelSwitchPending,
        modelSwitchStage: workspaceState.modelSwitchStage,
        selectedProvider: workspaceState.selectedProvider,
        selectedSupplierKey: workspaceState.selectedSupplierKey,
        configOptions: workspaceState.configOptions,
        optimisticTaskListByTaskId: workspaceState.optimisticTaskListByTaskId,
        workspaceInit: workspaceState.workspaceInit,
        taskStatus: displayedTaskState.taskStatus,
        taskError: displayedTaskState.taskError,
      };
    }),
  );

  const reloadSessionDisabled = useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
    // 已有会话只看自身运行态，其他会话忙碌不应阻止资源重载；最终准入由 Host 裁决。
    if (workspaceState.activeTaskId) {
      const status = workspaceState.taskRuntimeByTaskId[workspaceState.activeTaskId]?.status;
      return status === "creating" || status === "restoring" || status === "streaming";
    }
    const actionScope = resolveWorkspaceModelConfigSyncScope(workspaceState);
    return hasBusyTaskInWorkspaceProvider(
      actionScope.provider,
      workspaceState.taskRuntimeByTaskId,
      workspaceState.optimisticTaskListByTaskId,
      workspaceState.taskListCache,
      workspaceState.activeTaskId,
    );
  });

  return { workspaceShellZCodeState, reloadSessionDisabled };
}
