import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createImageIngestionExtension,
  normalizeIncomingImages,
  refreshStructuredImage,
  type ImageProcessingDiagnostic,
} from "./image-ingestion.js";

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

test("image ingestion uses the stricter profile and preserves text and ordering", async () => {
  const diagnostics: ImageProcessingDiagnostic[] = [];
  const first = { type: "text" as const, text: "before" };
  const last = { type: "text" as const, text: "after" };
  const content = [first, image, last];
  const result = await normalizeIncomingImages(content, {
    enabled: true,
    resizeOptions: { maxWidth: 1400, maxBytes: 128 * 1024, jpegQuality: 70 },
    resize: async (_bytes, mime, options) => {
      assert.equal(mime, "image/png");
      assert.deepEqual(options, {
        maxWidth: 1400,
        maxHeight: 2000,
        maxBytes: 128 * 1024,
        jpegQuality: 70,
      });
      return {
        data: "YQ==",
        mimeType: "image/jpeg",
        originalWidth: 2000,
        originalHeight: 1000,
        width: 1400,
        height: 700,
        wasResized: true,
      };
    },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(result[0], first);
  assert.deepEqual(result[1], { type: "image", data: "YQ==", mimeType: "image/jpeg" });
  assert.match(
    result[2]?.type === "text" ? result[2].text : "",
    /original 2000x1000, displayed at 1400x700/,
  );
  assert.equal(result[3], last);
  assert.equal(content[1], image);
  assert.equal(diagnostics[0]?.inputBase64Bytes, image.data.length);
  assert.equal(diagnostics[0]?.outputBase64Bytes, 4);
  assert.equal(diagnostics[0]?.failedImages, 0);
});

test("default image profile caps encoded bytes without shrinking screenshots upfront", async () => {
  await normalizeIncomingImages([image], {
    enabled: true,
    resizeOptions: { maxWidth: 4096, maxHeight: 4096, maxBytes: 5 * 1024 * 1024 },
    resize: async (_bytes, _mime, options) => {
      assert.deepEqual(options, {
        maxWidth: 2000,
        maxHeight: 2000,
        maxBytes: 512 * 1024,
        jpegQuality: 80,
      });
      return null;
    },
  });
});

test("disabled resizing and text-only results preserve identity and avoid processing", async () => {
  const content = [image];
  const resize = async () => {
    throw new Error("must not encode");
  };
  assert.equal(await normalizeIncomingImages(content, { enabled: false, resize }), content);
  const text = [{ type: "text" as const, text: "hello" }];
  assert.equal(await normalizeIncomingImages(text, { enabled: true, resize }), text);
});

test("unavailable and failing encoders preserve images and report only safe metadata", async () => {
  for (const resize of [
    async () => null,
    async () => {
      throw new Error("secret image path");
    },
  ]) {
    const diagnostics: ImageProcessingDiagnostic[] = [];
    const content = [image];
    const result = await normalizeIncomingImages(content, {
      enabled: true,
      resize,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    assert.equal(result, content);
    assert.equal(diagnostics[0]?.failedImages, 1);
    assert.equal(diagnostics[0]?.outputBase64Bytes, image.data.length);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret|aW1hZ2U=/);
  }
});

test("reencoding at the same dimensions adds no conflicting coordinate note", async () => {
  const result = await normalizeIncomingImages([image], {
    enabled: true,
    resize: async () => ({
      data: "YQ==",
      mimeType: "image/jpeg",
      originalWidth: 1000,
      originalHeight: 500,
      width: 1000,
      height: 500,
      wasResized: true,
    }),
  });
  assert.deepEqual(result, [{ type: "image", data: "YQ==", mimeType: "image/jpeg" }]);
});

test("Read double resizing keeps one mapping from the source file to the final pixels", async () => {
  const note =
    "Read image file [image/png]\n[Image: original 4000x2000, displayed at 2000x1000. Multiply coordinates by 2.00 to map to original image.]";
  const content = [{ type: "text" as const, text: note }, image];
  const result = await normalizeIncomingImages(content, {
    enabled: true,
    resize: async () => ({
      data: "YQ==",
      mimeType: "image/jpeg",
      originalWidth: 2000,
      originalHeight: 1000,
      width: 1000,
      height: 500,
      wasResized: true,
    }),
  });
  assert.equal(result.length, 2);
  assert.equal(
    result[0]?.type === "text" ? result[0].text : "",
    "Read image file [image/png]\n[Image: original 4000x2000, displayed at 1000x500. Multiply coordinates by 4.00 to map to original image.]",
  );
  assert.equal(content[0]?.text, note);
});

test("structured Read image remains usable by codemode with normalized bytes and note", () => {
  const structured = {
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
    note: "source note",
  };
  const content = [
    { type: "text" as const, text: "new mapping" },
    { ...image, data: "YQ==", mimeType: "image/jpeg" },
  ];
  assert.deepEqual(refreshStructuredImage(structured, [image], content), {
    type: "image",
    data: "YQ==",
    mimeType: "image/jpeg",
    note: "new mapping",
  });
  assert.equal(structured.data, image.data);
  const custom = { arbitrary: true };
  assert.equal(refreshStructuredImage(custom, [image], content), custom);
  const unrelated = { ...structured, data: "unrelated" };
  assert.equal(refreshStructuredImage(unrelated, [image], content), unrelated);
  for (const value of ["scalar", 0, false, null, [custom]]) {
    assert.equal(refreshStructuredImage(value, [image], content), value);
  }
});

test("invalid user images remain available to SDK validation for all input modes", async () => {
  const callbacks = new Map<string, (...args: never[]) => unknown>();
  const diagnostics: ImageProcessingDiagnostic[] = [];
  const extension = createImageIngestionExtension({
    autoResize: () => true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await extension.factory({
    on: (name: string, callback: (...args: never[]) => unknown) => {
      callbacks.set(name, callback);
    },
  } as never);
  const ctx = { sessionManager: { getSessionId: () => "test-session" } };
  for (const streamingBehavior of [undefined, "steer", "followUp"]) {
    const images = [image];
    assert.equal(
      await callbacks.get("input")?.(
        {
          text: "queued",
          images,
          streamingBehavior,
        } as never,
        ctx as never,
      ),
      undefined,
    );
    assert.equal(images[0], image);
  }
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.failedImages === 1));
});

test("diagnostics failures cannot change image processing results", async () => {
  const result = await normalizeIncomingImages([image], {
    enabled: true,
    resize: async () => null,
    onDiagnostic: () => {
      throw new Error("logger unavailable");
    },
  });
  assert.equal(result[0], image);
});
