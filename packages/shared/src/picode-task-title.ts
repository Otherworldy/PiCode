import type { ZCodeTaskMeta } from "./picode-task-types-core.js";

type TaskTitle = Pick<ZCodeTaskMeta, "title" | "titleOverridden" | "titleRevision">;

/** 活动时间会被运行态推进；已提交标题必须按自己的版本连同覆盖标记一起合并。 */
export function resolveVersionedTaskTitle(
  preferred: TaskTitle,
  fallback: TaskTitle,
): TaskTitle | undefined {
  const preferredRevision = preferred.titleRevision ?? 0;
  const fallbackRevision = fallback.titleRevision ?? 0;
  if (preferredRevision === 0 && fallbackRevision === 0) return undefined;
  const winner = fallbackRevision > preferredRevision ? fallback : preferred;
  return {
    title: winner.title,
    titleOverridden: winner.titleOverridden,
    titleRevision: winner.titleRevision,
  };
}
