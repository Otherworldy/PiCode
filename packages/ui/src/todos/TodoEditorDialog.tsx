import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FileText, ImagePlus, X } from "lucide-react";
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

const MAX_FILES = 8;

interface DraftFile extends TodoAttachment {
  id: string;
  previewUrl?: string;
}

export function TodoEditorDialog({
  open,
  projects,
  defaultProjectKey,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  projects: { workspacePath: string; workspaceIdentity?: string }[];
  defaultProjectKey: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    title: string;
    prompt: string;
    workspacePath: string;
    workspaceIdentity?: string;
    attachments: TodoAttachment[];
  }) => Promise<void>;
}) {
  const platform = useOptionalPlatform();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectKey, setProjectKey] = useState(defaultProjectKey);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPrompt("");
    setProjectKey(defaultProjectKey);
    setFiles((current) => {
      for (const file of current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      return [];
    });
  }, [defaultProjectKey, open]);

  async function addFiles(list: File[]) {
    const room = MAX_FILES - files.length;
    const next: DraftFile[] = [];
    for (const file of list.slice(0, room)) {
      const localPath = platform?.getPathForFile?.(file)?.trim() || undefined;
      const image = file.type.startsWith("image/");
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        fileName: file.name || (image ? "image.png" : "file"),
        mime: file.type || "application/octet-stream",
        bytes: file.size,
        ...(localPath ? { localPath } : { dataBase64: await readBase64(file) }),
        ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
    }
    setFiles((current) => [...current, ...next]);
  }

  function removeFile(id: string) {
    setFiles((current) => {
      const target = current.find((file) => file.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
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
              attachments: files.map(({ id: _id, previewUrl: _preview, ...file }) => file),
            })
              .then(() => onOpenChange(false))
              .finally(() => setBusy(false));
          }}
          onPaste={(event: ClipboardEvent) => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length === 0) return;
            event.preventDefault();
            void addFiles(pasted);
          }}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
            void addFiles(Array.from(event.dataTransfer.files));
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
            {files.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {files.map((file) => (
                  <li
                    key={file.id}
                    className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-card py-1 pr-1 pl-1"
                  >
                    {file.previewUrl ? (
                      <img src={file.previewUrl} alt="" className="size-10 rounded-md object-cover" />
                    ) : (
                      <span className="flex size-10 items-center justify-center rounded-md bg-surface">
                        <FileText className="size-4 text-foreground-subtle" />
                      </span>
                    )}
                    <span className="max-w-40 truncate text-ui-xs">{file.fileName}</span>
                    <button
                      type="button"
                      className="rounded-md p-1 text-foreground-subtle hover:bg-surface-hover"
                      aria-label={`移除 ${file.fileName}`}
                      onClick={() => removeFile(file.id)}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
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
                  void addFiles(Array.from(event.currentTarget.files ?? []));
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

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
