import { FileText, X } from "lucide-react";
import type { TodoAttachment } from "@zcode/shared";
import { todoAttachmentRecord } from "@/todos/todoAttachmentRecord.js";

export const MAX_TODO_FILES = 8;

export interface TodoDraftFile extends TodoAttachment {
  id: string;
  previewUrl?: string;
}

export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems.length > 0 ? fromItems : Array.from(data.files);
}

export function draftsFromStored(files: readonly TodoAttachment[]): TodoDraftFile[] {
  return files.map((file, index) => ({
    ...file,
    id: `stored-${index}-${file.fileName}`,
    ...(file.mime.startsWith("image/") && file.dataBase64
      ? { previewUrl: `data:${file.mime};base64,${file.dataBase64}` }
      : {}),
  }));
}

export function draftsToStored(files: readonly TodoDraftFile[]): TodoAttachment[] {
  return files.map(({ id: _id, previewUrl: _preview, ...file }) => file);
}

export function revokeDraftPreviews(files: readonly TodoDraftFile[]): void {
  for (const file of files) {
    if (file.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(file.previewUrl);
  }
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

export async function draftsFromBrowserFiles(
  list: readonly File[],
  options: {
    fromClipboard: boolean;
    room: number;
    pathForFile?: (file: File) => string | null | undefined;
  },
): Promise<TodoDraftFile[]> {
  const next: TodoDraftFile[] = [];
  for (const file of list.slice(0, Math.max(0, options.room))) {
    let localPath: string | undefined;
    if (!options.fromClipboard && options.pathForFile) {
      try {
        localPath = options.pathForFile(file)?.trim() || undefined;
      } catch {
        localPath = undefined;
      }
    }
    const record = todoAttachmentRecord(
      {
        fileName: file.name,
        mime: file.type || (options.fromClipboard ? "image/png" : ""),
        bytes: file.size,
        localPath,
        dataBase64: localPath ? undefined : await readBase64(file),
      },
      options.fromClipboard,
    );
    if (!record) continue;
    next.push({
      ...record,
      id: `${record.fileName}-${file.size}-${file.lastModified}-${next.length}`,
      ...(record.mime.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
    });
  }
  return next;
}

export function TodoAttachmentChips({
  files,
  onRemove,
}: {
  files: readonly TodoDraftFile[];
  onRemove?: (id: string) => void;
}) {
  if (files.length === 0) return null;
  return (
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
          {onRemove ? (
            <button
              type="button"
              className="rounded-md p-1 text-foreground-subtle hover:bg-surface-hover"
              aria-label={`移除 ${file.fileName}`}
              onClick={() => onRemove(file.id)}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
