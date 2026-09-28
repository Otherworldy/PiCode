import { readFile } from "node:fs/promises";
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
  return items.filter(isImage).map((item) => ({
    ref: filePathOf(item) ?? item.ref ?? item.filename ?? item.fileName ?? "image",
    fileName: item.filename || item.fileName || "image",
    mime: mimeOf(item),
    bytes: item.sizeBytes ?? item.bytes ?? 0,
  }));
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
