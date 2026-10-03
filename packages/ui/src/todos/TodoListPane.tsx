import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, LayoutGrid, List, ListTodo, Play, Plus } from "lucide-react";
import type { TodoItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  StatusChip,
  TODO_COLUMNS,
  TodoCard,
  projectLeaf,
  relativeTime,
  todoColumnOf,
} from "@/todos/todoBoard.js";
import { TodoEditorDialog } from "@/todos/TodoEditorDialog.js";

export function TodoListPane({
  onOpenSession,
}: {
  onOpenSession: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
}) {
  const { todoService } = useServices();
  const tabs = useTabStore((state) => state.tabs);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const projects = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const defaultKey =
    activeWorkspaceIdentity?.trim() || activeWorkspacePath || projects[0]?.workspacePath || "";
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"board" | "list">("board");
  const [showCanceled, setShowCanceled] = useState(true);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!todoService) return;
    const rows = await todoService.list(filter || undefined);
    setItems(rows.filter((item) => showCanceled || item.status !== "canceled"));
  }, [filter, showCanceled, todoService]);

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [refresh]);

  const detail = items.find((item) => item.id === detailId) ?? null;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh().catch(() => undefined);
    }
  }

  function openNew() {
    setEditorOpen(true);
  }

  if (!todoService) {
    return <p className="p-6 text-ui-sm text-foreground-subtle">当前 Host 没有 To-Dos。</p>;
  }

  const grouped = {
    todo: items.filter((item) => todoColumnOf(item.status) === "todo"),
    inProgress: items.filter((item) => todoColumnOf(item.status) === "inProgress"),
    attention: items.filter((item) => todoColumnOf(item.status) === "attention"),
    done: items.filter((item) => todoColumnOf(item.status) === "done"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 pt-2">
        <Select
          value={filter || "__all__"}
          onValueChange={(value) => setFilter(value === "__all__" ? "" : value)}
        >
          <SelectTrigger size="lg" variant="outline" className="rounded-full" aria-label="项目">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部项目</SelectItem>
            {projects.map((tab) => {
              const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
              return (
                <SelectItem key={key} value={key}>
                  {projectLeaf(tab.workspacePath)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <label className="inline-flex h-8 items-center gap-2 rounded-full bg-surface px-3 text-ui-sm">
          <input
            type="checkbox"
            checked={showCanceled}
            onChange={(event) => setShowCanceled(event.target.checked)}
          />
          显示已放弃
        </label>
        <div className="inline-flex h-8 rounded-full bg-surface p-0.5">
          <button
            type="button"
            aria-label="看板"
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 text-ui-sm",
              view === "board" ? "bg-card text-foreground" : "text-foreground-subtle",
            )}
            onClick={() => setView("board")}
          >
            <LayoutGrid className="size-3.5" />
            看板
          </button>
          <button
            type="button"
            aria-label="列表"
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 text-ui-sm",
              view === "list" ? "bg-card text-foreground" : "text-foreground-subtle",
            )}
            onClick={() => setView("list")}
          >
            <List className="size-3.5" />
            列表
          </button>
        </div>
        <div className="flex-1" />
        <Button type="button" size="sm" className="h-8 gap-1 rounded-full px-3.5" onClick={openNew}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      {error ? <p className="px-4 pb-2 text-ui-sm text-destructive">{error}</p> : null}
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <ListTodo className="size-10 text-foreground-subtlest" />
          <div>
            <p className="text-ui-base font-medium">还没有 To-Do</p>
            <p className="mt-1 max-w-sm text-ui-sm text-foreground-subtle">
              写下来就可以走开。它会在所选项目的独立工作树里跑，跑完等你审。
            </p>
          </div>
          <Button type="button" size="sm" className="gap-1.5" onClick={openNew}>
            <Plus className="size-3.5" />
            新建
          </Button>
        </div>
      ) : view === "list" ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          <div className="grid grid-cols-[7rem_1fr_10rem_6rem] gap-2 px-3 py-2 text-ui-xs text-foreground-subtle">
            <span>状态</span>
            <span>任务</span>
            <span>项目</span>
            <span>更新</span>
          </div>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setDetailId(item.id)}
                  className="grid w-full grid-cols-[7rem_1fr_10rem_6rem] items-center gap-2 rounded-xl border border-foreground/15 bg-card px-3 py-3 text-left hover:border-brand"
                >
                  <StatusChip status={item.status} />
                  <span className="truncate text-ui-sm font-medium">{item.title}</span>
                  <span className="truncate text-ui-xs text-foreground-subtle">
                    {projectLeaf(item.workspacePath)}
                  </span>
                  <span className="text-ui-xs text-foreground-subtle">
                    {relativeTime(item.updatedAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="grid h-full min-w-[56rem] grid-cols-4 gap-4 px-4 pb-4 pt-2">
            {TODO_COLUMNS.map((column) => {
              const rows = grouped[column.id];
              return (
                <section key={column.id} className="flex min-h-0 flex-col gap-2">
                  <div className="flex h-6 items-center gap-2 px-0.5">
                    <span className={cn("h-3.5 w-[3px] rounded-full", column.mark)} />
                    <h2 className="text-ui-xs font-semibold">{column.label}</h2>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-ui-xs font-medium leading-none tabular-nums",
                        column.id === "attention" && rows.length > 0
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-surface text-foreground-subtle",
                      )}
                    >
                      {rows.length}
                    </span>
                  </div>
                  {rows.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-foreground-subtle/30 p-4 text-center text-ui-xs text-foreground-subtle">
                      空
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-1">
                      {rows.map((item) => (
                        <TodoCard
                          key={item.id}
                          item={item}
                          now={now}
                          onOpen={() => setDetailId(item.id)}
                          onStart={() => void run(() => todoService.start(item.id))}
                          onAbandon={() => void run(() => todoService.abandon(item.id))}
                          onRestore={() => void run(() => todoService.restore(item.id))}
                          onDelete={() => void run(() => todoService.delete(item.id))}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}

      <TodoEditorDialog
        open={editorOpen}
        projects={projects}
        defaultProjectKey={filter || defaultKey}
        onOpenChange={setEditorOpen}
        onCreate={(input) => run(() => todoService.create(input))}
      />

      <Dialog open={detail != null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-w-lg">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.title}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3 text-ui-sm">
                <div className="flex items-center gap-2">
                  <StatusChip status={detail.status} />
                  <span className="truncate text-ui-xs text-foreground-subtle">
                    {projectLeaf(detail.workspacePath)}
                    {detail.branchName ? ` / ${detail.branchName}` : ""}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-foreground">{detail.prompt}</p>
                {detail.error ? (
                  <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-ui-xs text-destructive">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>{detail.error}</span>
                  </div>
                ) : null}
              </div>
              <DialogFooter className="gap-2 sm:justify-start">
                {detail.status === "todo" || detail.status === "failed" ? (
                  <Button size="sm" onClick={() => void run(() => todoService.start(detail.id))}>
                    <Play className="size-3.5" />
                    开始
                  </Button>
                ) : null}
                {detail.sessionId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onOpenSession(detail.workspacePath, detail.sessionId!, detail.workspaceIdentity)
                    }
                  >
                    打开会话
                  </Button>
                ) : null}
                {detail.status === "needs_review" ? (
                  <>
                    <Button size="sm" onClick={() => void run(() => todoService.merge(detail.id))}>
                      合并
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void run(() => todoService.complete(detail.id))}>
                      完成
                    </Button>
                  </>
                ) : null}
                {detail.status === "canceled" ? (
                  <Button size="sm" variant="outline" onClick={() => void run(() => todoService.restore(detail.id))}>
                    恢复
                  </Button>
                ) : detail.status !== "done" ? (
                  <Button size="sm" variant="ghost" onClick={() => void run(() => todoService.abandon(detail.id))}>
                    放弃
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void run(() => todoService.delete(detail.id)).then(() => setDetailId(null))}>
                  删除
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
