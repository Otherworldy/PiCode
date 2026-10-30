/**
 * 已由 session 接管的附件 ref 回到 composer 时的重建规则。
 *
 * 回退（回退到此处 / queue 撤回编辑）把附件 ref 原样交回输入框：这些内容已经在 session 里，
 * 不能再走 composer 的 upload/adopt。代价是 composer 只剩 ref、没有本地 File/object URL，
 * 而媒体 chip 的缩略图、预览、媒体类型判定全都依赖 objectUrl。
 *
 * 更麻烦的是授权：gateway 的 attachmentRead 按当前投影里的 user row 证明 ref 归属，而回退
 * 恰恰把那一行裁掉了。所以媒体缩略图只能由调用方在裁切前读出来，随 restore 请求按同下标带过来。
 */
import { nanoid } from "nanoid";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";

/** composer 用 object URL 渲染缩略图的三种媒体；其余附件本来就是文件图标。 */
export function isPreviewableComposerMediaMime(mime: string): boolean {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("image/") ||
    normalized.startsWith("video/") ||
    normalized === "application/pdf"
  );
}

/** 只释放 renderer 自己建的 blob；Desktop 本地媒体 URL 不属于 renderer 生命周期。 */
export function releaseAttachmentPreviewUrls(
  urls: readonly (string | undefined)[] | undefined,
): void {
  if (!urls) return;
  for (const url of urls) {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

export function buildSessionOwnedComposerAttachments(
  attachmentRefs: readonly AttachmentRef[],
  previewUrls?: readonly (string | undefined)[],
): ComposerAttachmentUploadItem[] {
  return attachmentRefs.map((attachmentRef, index) => {
    const id = nanoid();
    const previewUrl = previewUrls?.[index];
    return {
      id,
      filename: attachmentRef.fileName,
      mimeType: attachmentRef.mime,
      sizeBytes: attachmentRef.bytes,
      // 缩略图源由调用方在裁切前读出；缺席时 composer 退化成文件图标。
      ...(previewUrl ? { objectUrl: previewUrl } : {}),
      referenceOwnership: "session",
      uploadStatus: "ready",
      uploadProgress: 100,
      attachmentRef: { ...attachmentRef },
      operationId: `session-owned-${id}`,
      autoRetryCount: 0,
      runtimeRebuildRetryCount: 0,
      staged: false,
      adopted: true,
      showComplete: false,
      localZeroCopy: false,
    };
  });
}
