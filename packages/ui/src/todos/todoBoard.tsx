import type { ReactNode } from "react";
import { Ban, CircleAlert, Loader2, Play, RotateCcw, Trash2 } from "lucide-react";
import type { TodoItem, TodoStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export type TodoColumnId = "todo" | "inProgress" | "attention" | "done";

export const TODO_COLUMNS: { id: TodoColumnId; label: string; mark: string }[] = [
  { id: "todo", label: "待办", mark: "bg-foreground-subtle" },
  { id: "inProgress", label: "进行中", mark: "bg-brand" },
  { id: "attention", label: "需要你", mark: "bg-amber-500" },
  { id: "done", label: "完成", mark: "bg-emerald-500" },
];

const STATUS_LABEL: Record<TodoStatus, string> = {
  todo: "待开始",
  running: "进行中",
  needs_review: "待审",
  done: "完成",
  failed: "失败",
  canceled: "已放弃",
};

export function todoColumnOf(status: TodoStatus): TodoColumnId {
  if (status === "todo") return "todo";
  if (status === "running") return "inProgress";
  if (status === "needs_review" || status === "failed") return "attention";
  return "done";
}

export function projectLeaf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

export function relativeTime(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "刚刚";
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  return `${Math.floor(delta / day)} 天前`;
}

const STATUS_TONE: Record<TodoStatus, string> = {
  todo: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  running: "bg-brand/15 text-brand",
  needs_review: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  failed: "bg-destructive/15 text-destructive",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  canceled: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
};

export function StatusChip({ status }: { status: TodoStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-ui-xs font-medium leading-none",
        STATUS_TONE[status],
      )}
    >
      {status === "running" ? <Loader2 className="size-3 animate-spin" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

function CardIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick();
      }}
    >
      {children}
    </Button>
  );
}

export function TodoCard({
  item,
  now,
  onOpen,
  onStart,
  onTag,
  onAbandon,
  onRestore,
  onDelete,
  starting,
}: {
  item: TodoItem;
  now: number;
  onOpen: () => void;
  onStart: () => void;
  onTag?: (tag: string) => void;
  onAbandon: () => void;
  onRestore: () => void;
  onDelete: () => void;
  starting?: boolean;
}) {
  const canStart = item.status === "todo" || item.status === "failed";
  const canAbandon = item.status !== "done" && item.status !== "canceled";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col rounded-xl border border-foreground/15 bg-card p-3 text-left transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 break-words text-ui-sm font-medium leading-snug">{item.title}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <StatusChip status={item.status} />
          {canStart ? (
            <CardIconButton label="开始" onClick={onStart} disabled={starting}>
              {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            </CardIconButton>
          ) : null}
          {item.status === "canceled" ? (
            <CardIconButton label="恢复" onClick={onRestore}>
              <RotateCcw className="size-3.5" />
            </CardIconButton>
          ) : null}
          {canAbandon ? (
            <CardIconButton label="放弃" onClick={onAbandon}>
              <Ban className="size-3.5" />
            </CardIconButton>
          ) : null}
          <CardIconButton label="删除" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </CardIconButton>
        </div>
      </div>
      {item.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <button
              key={tag.toLocaleLowerCase()}
              type="button"
              className="rounded-full bg-surface px-2 py-0.5 text-ui-xs text-foreground-subtle hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onTag?.(tag);
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
      {item.prompt && item.prompt !== "见附件。" ? (
        <p className="mt-1.5 line-clamp-2 text-ui-xs leading-snug text-foreground-subtle">{item.prompt}</p>
      ) : null}
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-foreground-subtle">
        <span className="max-w-40 truncate">{projectLeaf(item.workspacePath)}</span>
        {item.branchName ? (
          <>
            <span className="text-foreground-subtlest">/</span>
            <span className="truncate font-mono">{item.branchName}</span>
          </>
        ) : null}
        <span className="text-foreground-subtlest">·</span>
        <span>{relativeTime(item.updatedAt, now)}</span>
      </div>
      {item.error && (item.status === "failed" || item.status === "needs_review") ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-ui-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{item.error}</span>
        </div>
      ) : null}
    </div>
  );
}
