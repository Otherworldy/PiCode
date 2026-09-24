import type { ZCodeTaskMeta } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";

/** 删掉 Pi 会话文件和列表行。当前正打开这条时回到草稿。 */
export async function deleteSessionTask(params: {
  services: Pick<IServiceAccessor, "zcodeTaskService">;
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;
}): Promise<void> {
  const { task } = params;
  await params.services.zcodeTaskService.deleteTask({
    taskId: task.taskId,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  });
  removeTaskFromTaskCaches({
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  });
  if (task.workspaceIdentity) {
    useRemotePinnedTaskStore
      .getState()
      .removeTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    useRemoteTimelineTaskStore
      .getState()
      .removeTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  }
  const store = useZCodeSessionStore.getState();
  const activeTaskId = store.getWorkspaceState(
    task.workspacePath,
    task.workspaceIdentity,
  ).activeTaskId;
  if (activeTaskId === task.taskId) {
    store.setActiveTaskId(task.workspacePath, null, task.workspaceIdentity);
  }
}

/** 右键/标题菜单共用：确认后删除当前会话。没有 taskId 时是草稿，不动作。 */
export function useDeleteSessionAction(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity" | "title">,
  remoteSessionId?: string,
): () => void {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(task.workspacePath, remoteSessionId, task.workspaceIdentity);
  return () => {
    if (!task.taskId) return;
    void (async () => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "confirmDialog.taskDeleteTitle" }),
        description: intl.formatMessage(
          { id: "confirmDialog.taskDeleteDescription" },
          { taskTitle: task.title.trim() || intl.formatMessage({ id: "taskList.untitled" }) },
        ),
        confirmLabel: intl.formatMessage({ id: "taskList.delete" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      try {
        await deleteSessionTask({ services, task });
      } catch (error) {
        logger.error("[deleteSessionTask] 删除会话失败", error);
        toast(intl.formatMessage({ id: "taskList.deleteFailed" }));
      }
    })();
  };
}
