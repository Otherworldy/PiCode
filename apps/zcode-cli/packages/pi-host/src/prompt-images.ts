import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

export interface PiPromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** 本地路径或 data URL。队列里只留路径，字节在真正 prompt 时再读。 */
export interface PiPromptAttachment {
  type?: string;
  path?: string;
  content?: string;
  filename?: string;
  fileName?: string;
  mimeType?: string;
  mime?: string;
  sizeBytes?: number;
  bytes?: number;
  ref?: string;
}

function mimeOf(item: PiPromptAttachment): string {
  return item.mimeType || item.mime || "image/png";
}

function isImage(item: PiPromptAttachment): boolean {
  if (item.type && item.type !== "image") return false;
  const mime = mimeOf(item).split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return item.type === "image" || mime.startsWith("image/");
}

function filePathOf(item: PiPromptAttachment): string | undefined {
  if (item.path && isAbsolute(item.path)) return item.path;
  if (item.ref && isAbsolute(item.ref)) return item.ref;
  return undefined;
}

export function promptAttachmentRefs(items: readonly PiPromptAttachment[] | undefined): AttachmentRef[] {
  if (!items?.length) return [];
  return items.map((item) => ({
    ref: filePathOf(item) ?? item.ref ?? item.filename ?? item.fileName ?? "file",
    fileName: item.filename || item.fileName || (isImage(item) ? "image" : "file"),
    mime: mimeOf(item),
    bytes: item.sizeBytes ?? item.bytes ?? 0,
  }));
}

const TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;
const TEXT_ATTACHMENT_EXT =
  /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu;

function isTextAttachment(item: PiPromptAttachment, file: string | undefined): boolean {
  if (item.type === "pdf" || item.type === "video" || item.type === "url") return false;
  const mime = (item.mimeType || item.mime || "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/typescript"
  ) {
    return true;
  }
  if (mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf") {
    return false;
  }
  return TEXT_ATTACHMENT_EXT.test(item.filename || item.fileName || file || "");
}

/** 非图片附件写进正文。Pi 的 prompt 只有 images，丢掉文件等于没发给模型。 */
export async function appendFileAttachments(
  text: string,
  items: readonly PiPromptAttachment[] | undefined,
): Promise<string> {
  const blocks: string[] = [];
  for (const item of items ?? []) {
    if (isImage(item)) continue;
    const block = await fileAttachmentBlock(item);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return text;
  const hidden = `<zcode-file>\n${blocks.join("\n\n")}\n</zcode-file>`;
  return text ? `${text}\n\n${hidden}` : hidden;
}

async function fileAttachmentBlock(item: PiPromptAttachment): Promise<string | undefined> {
  const name = item.filename || item.fileName || "file";
  const file = filePathOf(item);
  if (
    typeof item.content === "string" &&
    item.content.length > 0 &&
    !item.content.startsWith("data:") &&
    item.type !== "pdf"
  ) {
    return `Attached file: ${name}\n${clipText(item.content)}`;
  }
  if (!file) return undefined;
  if (!isTextAttachment(item, file)) return `Attached file: ${name}\n${file}`;
  try {
    const info = await stat(file);
    const length = Math.min(info.size, TEXT_ATTACHMENT_MAX_BYTES);
    const handle = await open(file, "r");
    try {
      const buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, 0);
      const truncated = info.size > TEXT_ATTACHMENT_MAX_BYTES ? `\n[truncated, full file: ${file}]` : "";
      return `Attached file: ${name}\n${file}\n${buf.toString("utf8")}${truncated}`;
    } finally {
      await handle.close();
    }
  } catch {
    return `Attached file: ${name}\n${file}`;
  }
}

function clipText(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= TEXT_ATTACHMENT_MAX_BYTES) return text;
  return `${Buffer.from(text).subarray(0, TEXT_ATTACHMENT_MAX_BYTES).toString("utf8")}\n[truncated]`;
}

export async function loadPromptImages(
  items: readonly PiPromptAttachment[] | undefined,
): Promise<PiPromptImage[]> {
  const images: PiPromptImage[] = [];
  for (const item of items ?? []) {
    if (!isImage(item)) continue;
    const mimeType = mimeOf(item);
    const file = filePathOf(item);
    if (file) {
      try {
        images.push({ type: "image", data: (await readFile(file)).toString("base64"), mimeType });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`image unreadable: ${item.filename || item.fileName || file}: ${message}`);
      }
      continue;
    }
    const content = item.content ?? "";
    if (content.startsWith("data:")) {
      const comma = content.indexOf(",");
      if (comma >= 0) {
        images.push({ type: "image", data: content.slice(comma + 1), mimeType });
        continue;
      }
    }
    throw new Error(`image unreadable: ${item.filename || item.fileName || "image"}`);
  }
  return images;
}
