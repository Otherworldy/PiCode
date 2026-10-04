import { CircleAlert, Loader2, Play } from "lucide-react";
import type { ITodoService } from "@zcode/services";
import type { TodoItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useAlertDialog } from "@/hooks/useAlertDialog.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { StatusChip, projectLeaf } from "@/todos/todoBoard.js";
import { TodoTagField } from "@/todos/TodoTagField.js";

function isDirtyMergeError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "dirty"
  );
}

export function TodoDetailDialog({
  detail,
  draft,
  knownTags,
  starting,
  todoService,
  onDraft,
  onClose,
  onRun,
  onStart,
  onOpenSession,
}: {
  detail: TodoItem | null;
  draft: { title: string; prompt: string };
  knownTags: string[];
  starting: boolean;
  todoService: ITodoService;
  onDraft: (draft: { title: string; prompt: string }) => void;
  onClose: () => void;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
  onStart: (id: string) => void;
  onOpenSession: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
}) {
  const requestAlert = useAlertDialog();
  const editable = detail?.status === "todo";
  return (
    <Dialog open={detail != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        {detail ? (
          <>
            <DialogHeader>
              <DialogTitle>{editable ? "修改" : detail.title}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3 text-ui-sm">
              <div className="flex items-center gap-2">
                <StatusChip status={detail.status} />
                <span className="truncate text-ui-xs text-foreground-subtle">
                  {projectLeaf(detail.workspacePath)}
                  {detail.branchName ? ` / ${detail.branchName}` : ""}
                </span>
              </div>
              {editable ? (
                <>
                  <Input
                    size="lg"
                    value={draft.title}
                    onChange={(event) => onDraft({ ...draft, title: event.target.value })}
                  />
                  <Textarea
                    value={draft.prompt}
                    onChange={(event) => onDraft({ ...draft, prompt: event.target.value })}
                    className="min-h-32 rounded-xl bg-surface px-3 py-2"
                  />
                </>
              ) : (
                <p className="whitespace-pre-wrap text-foreground">{detail.prompt}</p>
              )}
              <TodoTagField
                tags={detail.tags}
                suggestions={knownTags}
                onChange={(tags) => void onRun(() => todoService.setTags(detail.id, tags))}
              />
              {detail.error ? (
                <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-ui-xs text-destructive">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>{detail.error}</span>
                </div>
              ) : null}
            </div>
            <DialogFooter className="gap-2 sm:justify-start">
              {editable ? (
                <Button
                  size="sm"
                  disabled={
                    !draft.title.trim() || (!draft.prompt.trim() && detail.attachments.length === 0)
                  }
                  onClick={() => void onRun(() => todoService.update(detail.id, draft))}
                >
                  保存
                </Button>
              ) : null}
              {detail.status === "todo" || detail.status === "failed" ? (
                <Button size="sm" disabled={starting} onClick={() => onStart(detail.id)}>
                  {starting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  开始
                </Button>
              ) : null}
              {detail.sessionId || detail.status === "needs_review" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!detail.sessionId) {
                      void onRun(async () => {
                        throw new Error("会话已删除，无法打开。仍可合并或完成。");
                      });
                      return;
                    }
                    onOpenSession(detail.workspacePath, detail.sessionId, detail.workspaceIdentity);
                  }}
                >
                  打开会话
                </Button>
              ) : null}
              {detail.status === "needs_review" ? (
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      void onRun(async () => {
                        try {
                          await todoService.merge(detail.id);
                        } catch (error) {
                          if (!isDirtyMergeError(error)) throw error;
                          const confirmed = await requestAlert({
                            title: "主工作区有未提交改动",
                            description:
                              "将用模型为这些改动写提交说明，提交到基线分支，然后再合并这条 To-Do。冲突会停在待审。",
                            actionLabel: "提交并合并",
                          });
                          if (!confirmed) return;
                          await todoService.merge(detail.id, { commitDirty: true });
                        }
                      })
                    }
                  >
                    合并
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onRun(() => todoService.complete(detail.id))}
                  >
                    完成
                  </Button>
                </>
              ) : null}
              {detail.status === "canceled" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onRun(() => todoService.restore(detail.id))}
                >
                  恢复
                </Button>
              ) : detail.status !== "done" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onRun(() => todoService.abandon(detail.id))}
                >
                  放弃
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onRun(() => todoService.delete(detail.id).then(onClose))}
              >
                删除
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
