import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZCodeApp } from "../app/types.js";
import type { SessionOwner } from "./session-owner.js";
import {
  previewHostedWorkspaceFileRewind,
  applyHostedWorkspaceFileRewind,
} from "./hosted-file-rewind.js";

export async function previewSessionFileRewind(
  record: SessionOwner,
  options: Parameters<ZCodeApp["runtime"]["previewWorkspaceFileRewind"]>[0],
) {
  return record.hosted
    ? previewHostedWorkspaceFileRewind(record.hosted, options)
    : record.app.runtime.previewWorkspaceFileRewind(options);
}
export async function applySessionFileRewind(
  record: SessionOwner,
  options: Parameters<ZCodeApp["runtime"]["applyWorkspaceFileRewind"]>[0],
) {
  return record.hosted
    ? applyHostedWorkspaceFileRewind(record.hosted, options)
    : record.app.runtime.applyWorkspaceFileRewind(options);
}
export async function restoreSessionHistory(record: SessionOwner) {
  if (!record.hosted) return record.app.restoreRewoundConversation?.();
  record.hosted.reloadHistory(await readFile(record.hosted.sessionFile, "utf8").catch(() => ""));
}
export async function writeSessionAttachment(
  record: SessionOwner,
  input: Parameters<ZCodeApp["writePromptAttachment"]>[0],
) {
  if (!record.hosted) return record.app.writePromptAttachment(input);
  const dir = join(tmpdir(), "picode-prompt-images");
  await mkdir(dir, { recursive: true });
  const safe = input.fileName.replace(/[^\w.-]+/g, "_").slice(0, 40) || "image";
  // 附件目录跨会话共享，毫秒时间戳会碰撞；UUID 与独占创建保留每次上传的字节。
  const ref = join(dir, `${randomUUID()}-${safe}`);
  await writeFile(ref, input.bytes, { flag: "wx" });
  return { ref };
}
export async function readSessionAttachment(
  record: SessionOwner,
  input: Parameters<ZCodeApp["readPromptAttachment"]>[0],
) {
  if (!record.hosted) return record.app.readPromptAttachment(input);
  const bytes = await readFile(input.ref);
  if (bytes.byteLength > input.maxBytes) throw new Error("fault.attachment.previewTooLarge");
  return { bytes, mediaType: input.mime };
}
