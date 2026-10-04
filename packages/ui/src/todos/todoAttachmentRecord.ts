import type { TodoAttachment } from "@zcode/shared";

/**
 * 剪贴板文件的路径是临时的，关掉编辑就会被清掉。
 * 这种只留正文，下次打开还能画出来。本地拖入或选中的文件仍只记路径。
 */
export function todoAttachmentRecord(
  file: {
    fileName: string;
    mime: string;
    bytes: number;
    localPath?: string;
    dataBase64?: string;
  },
  fromClipboard: boolean,
): TodoAttachment | null {
  const mime = file.mime.trim() || "application/octet-stream";
  const fileName = file.fileName.trim() || (mime.startsWith("image/") ? "image.png" : "file");
  const localPath = fromClipboard ? undefined : file.localPath?.trim() || undefined;
  if (localPath) return { fileName, mime, bytes: file.bytes, localPath };
  const dataBase64 = file.dataBase64?.trim();
  if (!dataBase64) return null;
  return { fileName, mime, bytes: file.bytes, dataBase64 };
}
