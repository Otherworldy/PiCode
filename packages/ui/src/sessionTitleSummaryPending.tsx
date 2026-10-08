import { useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { IZCodeTaskService } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { updateTaskQueryCacheTaskMetaPreservingMembership } from "@/store/taskQueryCacheStore.js";

const pending = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function sessionTitleSummaryKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): string {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}\0${task.taskId}`;
}

export function subscribeSessionTitleSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isSessionTitleSummarizing(key: string): boolean {
  return pending.has(key);
}

function begin(key: string): boolean {
  if (pending.has(key)) return false;
  pending.add(key);
  notify();
  return true;
}

function end(key: string): void {
  if (!pending.delete(key)) return;
  notify();
}

/** 右键总结：行内转圈，完成后立刻换掉当前列表里的标题。 */
export function requestSessionTitleSummary(params: {
  service: IZCodeTaskService;
  task: ZCodeTaskMeta;
  onError: () => void;
}): void {
  const key = sessionTitleSummaryKey(params.task);
  if (!begin(key)) return;
  void params.service
    .summarizeTaskTitle({
      taskId: params.task.taskId,
      workspacePath: params.task.workspacePath,
      ...(params.task.workspaceIdentity
        ? { workspaceIdentity: params.task.workspaceIdentity }
        : {}),
    })
    .then((meta) => {
      useZCodeSessionStore
        .getState()
        .upsertOptimisticTaskListItem(
          params.task.workspacePath,
          meta,
          params.task.workspaceIdentity,
        );
      updateTaskQueryCacheTaskMetaPreservingMembership(meta);
    })
    .catch(() => {
      params.onError();
    })
    .finally(() => {
      end(key);
    });
}

export function SessionTitleSummaryMark({
  task,
  label,
}: {
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">;
  label: string;
}) {
  const key = sessionTitleSummaryKey(task);
  const summarizing = useSyncExternalStore(
    subscribeSessionTitleSummary,
    () => isSessionTitleSummarizing(key),
    () => false,
  );
  if (!summarizing) return null;
  return (
    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-label={label} />
  );
}
