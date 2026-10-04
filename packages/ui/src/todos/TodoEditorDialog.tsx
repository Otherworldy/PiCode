import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ImagePlus } from "lucide-react";
import type { TodoAttachment } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { projectLeaf } from "@/todos/todoBoard.js";
import {
  clipboardFiles,
  draftsFromBrowserFiles,
  draftsToStored,
  MAX_TODO_FILES,
  revokeDraftPreviews,
  TodoAttachmentChips,
  type TodoDraftFile,
} from "@/todos/todoAttachments.js";
import { TodoTagField } from "@/todos/TodoTagField.js";

export function TodoEditorDialog({
  open,
  projects,
  defaultProjectKey,
  onOpenChange,
  onCreate,
  suggestions,
}: {
  open: boolean;
  projects: { workspacePath: string; workspaceIdentity?: string }[];
  defaultProjectKey: string;
  onOpenChange: (open: boolean) => void;
  suggestions: string[];
  onCreate: (input: {
    title: string;
    prompt: string;
    workspacePath: string;
    workspaceIdentity?: string;
    attachments: TodoAttachment[];
    tags: string[];
  }) => Promise<void>;
}) {
  const platform = useOptionalPlatform();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectKey, setProjectKey] = useState(defaultProjectKey);
  const [files, setFiles] = useState<TodoDraftFile[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPrompt("");
    setProjectKey(defaultProjectKey);
    setTags([]);
    setFiles((current) => {
      revokeDraftPreviews(current);
      return [];
    });
  }, [defaultProjectKey, open]);

  async function addFiles(list: File[], fromClipboard: boolean) {
    const next = await draftsFromBrowserFiles(list, {
      fromClipboard,
      room: MAX_TODO_FILES - files.length,
      pathForFile: (file) => platform?.getPathForFile?.(file),
    });
    setFiles((current) => [...current, ...next]);
  }

  function removeFile(id: string) {
    setFiles((current) => {
      revokeDraftPreviews(current.filter((file) => file.id === id));
      return current.filter((file) => file.id !== id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const project = projects.find(
              (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === projectKey,
            );
            if (!project || busy) return;
            setBusy(true);
            void onCreate({
              title,
              prompt,
              workspacePath: project.workspacePath,
              workspaceIdentity: project.workspaceIdentity,
              attachments: draftsToStored(files),
              tags,
            })
              .then(() => onOpenChange(false))
              .finally(() => setBusy(false));
          }}
          onPasteCapture={(event: ClipboardEvent) => {
            const pasted = clipboardFiles(event.clipboardData);
            if (pasted.length === 0) return;
            event.preventDefault();
            void addFiles(pasted, true);
          }}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
            void addFiles(Array.from(event.dataTransfer.files), false);
          }}
        >
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>新建 To-Do</DialogTitle>
          </DialogHeader>
          <div className={cn("flex flex-col gap-3 px-5 py-4", dragOver && "bg-surface")}>
            <Input
              size="lg"
              placeholder="要做什么？"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              autoFocus
            />
            <Textarea
              placeholder="说明。可以贴截图，或把文件拖进来。"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-32 rounded-xl bg-surface px-3 py-2"
              required={files.length === 0}
            />
            <TodoTagField tags={tags} suggestions={suggestions} onChange={setTags} />
            <TodoAttachmentChips files={files} onRemove={removeFile} />
          </div>
          <DialogFooter className="items-center border-t border-border px-5 py-3 sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="gap-1.5"
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
              <Select value={projectKey || undefined} onValueChange={setProjectKey}>
                <SelectTrigger size="lg" variant="outline" className="max-w-48" aria-label="项目">
                  <SelectValue placeholder="项目" />
                </SelectTrigger>
                <SelectContent>
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
            </div>
            <Button type="submit" size="lg" disabled={busy}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
