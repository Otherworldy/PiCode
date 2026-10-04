import type { TodoAttachment, TodoItem } from "@zcode/shared";

export function storedAttachments(raw: string | null): TodoItem["attachments"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TodoItem["attachments"];
    return Array.isArray(parsed) ? usableAttachments(parsed) : [];
  } catch {
    return [];
  }
}

/** 有正文就丢掉路径。剪贴板临时文件下次打开编辑已经不在了。 */
export function usableAttachments(input: readonly TodoAttachment[] | undefined): TodoAttachment[] {
  const kept: TodoAttachment[] = [];
  for (const file of input ?? []) {
    const fileName = file.fileName?.trim();
    if (!fileName) continue;
    const dataBase64 = file.dataBase64?.trim();
    const mime = file.mime || "application/octet-stream";
    if (dataBase64) {
      kept.push({ fileName, mime, bytes: file.bytes, dataBase64 });
      continue;
    }
    const localPath = file.localPath?.trim();
    if (localPath) kept.push({ fileName, mime, bytes: file.bytes, localPath });
  }
  return kept;
}
