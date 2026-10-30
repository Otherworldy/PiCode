import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import {
  buildSessionOwnedComposerAttachments,
  isPreviewableComposerMediaMime,
  releaseAttachmentPreviewUrls,
} from "./sessionOwnedComposerAttachments.js";

function imageRef(ref: string): AttachmentRef {
  return { ref, fileName: `${ref}.png`, mime: "image/png", bytes: 3 };
}

test("restored session-owned media keeps the preview source read before the rewind", () => {
  const refs = [imageRef("a"), imageRef("b")];
  const items = buildSessionOwnedComposerAttachments(refs, [
    "blob:http://localhost/a",
    undefined,
  ]);

  // 回退后 gateway 已经没有行能授权这些 ref，缩略图只能靠裁切前读出的 objectUrl。
  assert.equal(items[0]?.objectUrl, "blob:http://localhost/a");
  assert.equal(items[1]?.objectUrl, undefined);
  assert.equal(items[0]?.referenceOwnership, "session");
  assert.equal(items[0]?.uploadStatus, "ready");
  assert.equal(items[0]?.adopted, true);
  assert.equal(items[0]?.staged, false);
});

test("restored session-owned items never share the caller's AttachmentRef object", () => {
  const ref = imageRef("c");
  const items = buildSessionOwnedComposerAttachments([ref], ["blob:http://localhost/c"]);

  assert.notEqual(items[0]?.attachmentRef, ref);
  assert.deepEqual(items[0]?.attachmentRef, ref);
});

test("restored session-owned items stay distinct when the same ref is restored twice", () => {
  const ref = imageRef("d");
  const items = buildSessionOwnedComposerAttachments([ref, ref], [
    "blob:http://localhost/d1",
    "blob:http://localhost/d2",
  ]);

  assert.equal(items.length, 2);
  assert.notEqual(items[0]?.id, items[1]?.id);
  assert.deepEqual(
    items.map((item) => item.objectUrl),
    ["blob:http://localhost/d1", "blob:http://localhost/d2"],
  );
});

test("only image, video and pdf attachments have a composer thumbnail to restore", () => {
  assert.equal(isPreviewableComposerMediaMime("image/png"), true);
  assert.equal(isPreviewableComposerMediaMime("IMAGE/PNG; charset=binary"), true);
  assert.equal(isPreviewableComposerMediaMime("video/mp4"), true);
  assert.equal(isPreviewableComposerMediaMime("application/pdf"), true);
  assert.equal(isPreviewableComposerMediaMime("text/plain"), false);
  assert.equal(isPreviewableComposerMediaMime("application/octet-stream"), false);
});

test("releasing preview urls only revokes renderer-owned blobs", () => {
  const revoked: string[] = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    releaseAttachmentPreviewUrls([
      "blob:http://localhost/a",
      undefined,
      // Desktop 本地媒体 URL 由 host 管理，revoke 它会把仍要用的预览打断。
      "zcode-local-media://video/1",
    ]);
    releaseAttachmentPreviewUrls(undefined);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
  assert.deepEqual(revoked, ["blob:http://localhost/a"]);
});
