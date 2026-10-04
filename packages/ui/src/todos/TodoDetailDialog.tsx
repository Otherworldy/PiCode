import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { CircleAlert, ImagePlus, Loader2, Play } from "lucide-react";
import type { ITodoService } from "@zcode/services";
import type { TodoItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { StatusChip, projectLeaf } from "@/todos/todoBoard.js";
import {
  clipboardFiles,
  draftsFromBrowserFiles,
  draftsFromStored,
  draftsToStored,
  MAX_TODO_FILES,
  revokeDraftPreviews,
  TodoAttachmentChips,
  type TodoDraftFile,
} from "@/todos/todoAttachments.js";
import { TodoTagField } from "@/todos/TodoTagField.js";

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
  const platform = useOptionalPlatform();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editable = detail?.status === "todo";
  const attachmentKey = detail
    ? `${detail.id}:${detail.attachments
        .map(
          (file) =>
            `${file.fileName}:${file.bytes}:${file.dataBase64?.length ?? 0}:${file.localPath ?? ""}`,
        )
        .join("|")}`
    : "";
  const [override, setOverride] = useState<TodoDraftFile[] | null>(null);
  const [overrideKey, setOverrideKey] = useState(attachmentKey);
  const droppedRef = useRef<TodoDraftFile[] | null>(null);
  if (overrideKey !== attachmentKey) {
    droppedRef.current = override;
    setOverrideKey(attachmentKey);
    setOverride(null);
  }
  const files = override ?? (detail ? draftsFromStored(detail.attachments) : []);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    const dropped = droppedRef.current;
    if (!dropped) return;
    droppedRef.current = null;
    revokeDraftPreviews(dropped);
  }, [attachmentKey]);
  useEffect(() => () => revokeDraftPreviews(filesRef.current), []);

  async function addFiles(list: File[], fromClipboard: boolean) {
    const next = await draftsFromBrowserFiles(list, {
      fromClipboard,
      room: MAX_TODO_FILES - files.length,
      pathForFile: (file) => platform?.getPathForFile?.(file),
    });
    if (next.length === 0) return;
    setOverride([...files, ...next]);
  }

  return (
    <Dialog open={detail != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-lg"
        onPasteCapture={(event: ClipboardEvent) => {
          if (!editable) return;
          const pasted = clipboardFiles(event.clipboardData);
          if (pasted.length === 0) return;
          event.preventDefault();
          void addFiles(pasted, true);
        }}
        onDragOver={(event: DragEvent) => {
          if (!editable) return;
          event.preventDefault();
        }}
        onDrop={(event: DragEvent) => {
          if (!editable) return;
          event.preventDefault();
          void addFiles(Array.from(event.dataTransfer.files), false);
        }}
      >
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
                    placeholder="说明。可以贴截图，或把文件拖进来。"
                    className="min-h-32 rounded-xl bg-surface px-3 py-2"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-fit gap-1.5"
                    onClick={() => inputRef.current?.click()}
                  >
                    <ImagePlus className="size-3.5" />
                    文件或图片
                  </Button>
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void addFiles(Array.from(event.currentTarget.files ?? []), false);
                      event.currentTarget.value = "";
                    }}
                  />
                </>
              ) : (
                <p className="whitespace-pre-wrap text-foreground">{detail.prompt}</p>
              )}
              <TodoAttachmentChips
                files={files}
                onRemove={
                  editable
                    ? (id) => {
                        const removed = files.filter((file) => file.id === id);
                        revokeDraftPreviews(removed);
                        setOverride(files.filter((file) => file.id !== id));
                      }
                    : undefined
                }
              />
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
                  disabled={!draft.title.trim() || (!draft.prompt.trim() && files.length === 0)}
                  onClick={() =>
                    void onRun(() =>
                      todoService.update(detail.id, {
                        ...draft,
                        attachments: draftsToStored(files),
                      } as Parameters<ITodoService["update"]>[1]),
                    )
                  }
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
                  <Button size="sm" onClick={() => void onRun(() => todoService.merge(detail.id))}>
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
