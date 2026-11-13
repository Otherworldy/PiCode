import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { runZcodeSubagent } from "./host-capabilities.js";
import { normalizeIncomingImages } from "./image-ingestion.js";
import {
  BUDGET,
  TIMEOUT,
  sourcePng,
  noisyPng,
  urls,
  text,
  imageOf,
  assertCompressed,
  fixture,
  imageTools,
  history,
  type Block,
} from "../test/fixtures/image-pipeline.js";

test(
  "real SDK PNG compression is bounded, idempotent and honors stricter limits",
  TIMEOUT,
  async () => {
    const image: ImageContent = {
      type: "image",
      data: (await sourcePng).toString("base64"),
      mimeType: "image/png",
    };
    assert.ok(image.data.length > BUDGET);
    const content = [
      { type: "text" as const, text: "before" },
      image,
      { type: "text" as const, text: "after" },
    ];
    const result = await normalizeIncomingImages(content, { enabled: true });
    const compressed = imageOf(result);
    assert.notEqual(compressed.data, image.data);
    assertCompressed(`data:${compressed.mimeType};base64,${compressed.data}`);
    assert.equal(result[0], content[0]);
    assert.equal(result.at(-1), content[2]);
    assert.match(text(result), /original 720x1280, displayed at \d+x\d+/);
    assert.deepEqual(await normalizeIncomingImages(result, { enabled: true }), result);
    const strict = await normalizeIncomingImages([image], {
      enabled: true,
      resizeOptions: { maxWidth: 360, maxHeight: 640, maxBytes: 128 * 1024 },
    });
    assert.ok(imageOf(strict).data.length <= 128 * 1024);
    assert.match(text(strict), /displayed at 360x640/);
  },
);

test(
  "factory user image is persisted once and reused across requests and reopen",
  TIMEOUT,
  async (t) => {
    const f = await fixture(t);
    const port = await f.factory();
    await port.prompt("Inspect generated pixels", { images: [f.image] });
    await port.waitTurn?.();
    assert.equal(f.bodies.length, 1);
    const [url] = urls(f.bodies[0]!);
    assert.ok(url);
    assertCompressed(url);
    const persisted = await history(port.sessionFile);
    const first = persisted.find((message) => message.role === "user");
    assert.ok(first && Array.isArray(first.content));
    assert.equal(imageOf(first.content).data, url.split(",")[1]);
    await port.prompt("Reuse historical pixels");
    await port.waitTurn?.();
    assert.deepEqual(urls(f.bodies[1]!), [url]);
    await port.dispose();
    const reopened = await f.factory(port.sessionFile);
    await reopened.prompt("Reuse after reload");
    await reopened.waitTurn?.();
    assert.deepEqual(urls(f.bodies[2]!), [url]);
    assert.equal(f.diagnostics.length, 1);
    assert.equal(f.diagnostics[0]?.source, "input");
    assert.deepEqual(
      (await history(port.sessionFile)).find((message) => message.role === "user"),
      first,
    );
    assert.deepEqual(await readFile(f.path), await sourcePng);
  },
);

test(
  "factory and runZcodeSubagent share image ingestion for real builtin read",
  TIMEOUT,
  async (t) => {
    const f = await fixture(t, [
      { tool: "read", args: { path: "source.png" } },
      {},
      { tool: "read", args: { path: "source.png" } },
      {},
    ]);
    const port = await f.factory();
    await port.prompt("Read source.png");
    await port.waitTurn?.();
    assert.equal(f.bodies.length, 2);
    assertCompressed(urls(f.bodies[1]!)[0]!);
    const result = await runZcodeSubagent({
      cwd: f.dir,
      agentDir: f.agentDir,
      parentSessionId: port.sessionId,
      parentSessionFile: port.sessionFile,
      modelRuntime: f.modelRuntime,
      model: f.model,
      thinkingLevel: "off",
      profile: {
        name: "image-reader",
        description: "Read generated pixels",
        systemPrompt: "Read images",
        tools: ["read"],
      },
      task: "Read source.png",
      check: async () => "allow",
      signal: t.signal,
      onImageDiagnostic: (entry) => f.diagnostics.push(entry),
    });
    assert.match(result, /ok/);
    assert.equal(f.bodies.length, 4);
    assertCompressed(urls(f.bodies[3]!)[0]!);
    assert.equal(f.diagnostics.length, 2);
    assert.ok(
      f.diagnostics.every((entry) => entry.toolName === "read" && entry.source === "tool_result"),
    );
    assert.equal(f.diagnostics[1]?.parentSessionId, port.sessionId);
    assert.notEqual(f.diagnostics[1]?.sessionId, f.diagnostics[0]?.sessionId);
    assert.deepEqual(await readFile(f.path), await sourcePng);
  },
);

test(
  "custom MCP-like and nested executeTool images preserve content and call pairing",
  TIMEOUT,
  async (t) => {
    const f = await fixture(t, [
      { tool: "mcp__fixture__screenshot" },
      {},
      { tool: "nested_image" },
      {},
    ]);
    const session = await f.sdk([imageTools(f.image)]);
    await session.prompt("Capture pixels");
    await session.prompt("Capture through nested tool");
    assert.equal(f.bodies.length, 4);
    assert.ok(urls(f.bodies[3]!).length >= 2);
    urls(f.bodies[3]!).forEach(assertCompressed);
    const results = (await history(session.sessionFile!)).filter(
      (message) => message.role === "toolResult",
    );
    assert.deepEqual(
      results.map((message) => [message.toolName, message.toolCallId]),
      [
        ["mcp__fixture__screenshot", "call-0"],
        ["nested_image", "call-2"],
      ],
    );
    for (const message of results) {
      assert.equal(message.isError, false);
      assert.equal(message.content[0]?.type === "text" ? message.content[0].text : "", "before");
      assert.equal(
        message.content.at(-1)?.type === "text"
          ? (message.content.at(-1) as { text: string }).text
          : "",
        "after",
      );
    }
    assert.deepEqual(imageOf(results[0]!.content), imageOf(results[1]!.content));
    const nested = f.diagnostics.find((entry) => entry.parentToolCallId === "call-2");
    assert.ok(nested);
    assert.equal(nested.toolName, "mcp__fixture__screenshot");
    assert.equal(nested.toolCallId, "call-2/1");
    assert.equal(
      f.bodies[1]!.messages.find((message) => message.role === "tool")?.tool_call_id,
      "call-0",
    );
  },
);

test(
  "busy SDK steer and followUp images are normalized before ordered admission",
  TIMEOUT,
  async (t) => {
    const gate = Promise.withResolvers<void>();
    t.after(() => gate.resolve());
    const f = await fixture(t, [{ gate: gate.promise }]);
    const session = await f.sdk();
    const turn = session.prompt("Start");
    await f.received;
    assert.equal(session.isStreaming, true);
    await session.followUp("queued-follow-up", [f.image]);
    await session.steer("queued-steer", [f.image]);
    gate.resolve();
    await turn;
    assert.equal(f.bodies.length, 3);
    assert.deepEqual(
      f.bodies[1]!.messages.filter((message) => message.role === "user").map(
        (message) => text(message.content).split("\n")[0],
      ),
      ["Start", "queued-steer"],
    );
    assert.deepEqual(
      f.bodies[2]!.messages.filter((message) => message.role === "user").map(
        (message) => text(message.content).split("\n")[0],
      ),
      ["Start", "queued-steer", "queued-follow-up"],
    );
    const images = urls(f.bodies[2]!);
    assert.equal(images.length, 2);
    images.forEach(assertCompressed);
    assert.deepEqual(urls(f.bodies[1]!), [images[0]]);
    const users = (await history(session.sessionFile!)).filter(
      (message) => message.role === "user",
    );
    assert.deepEqual(
      users.slice(1).map((message) => imageOf(message.content as Block[]).data),
      images.map((url) => url.split(",")[1]),
    );
    assert.equal(f.diagnostics.length, 2);
  },
);

test("real Read double resize maps final pixels to the source screenshot", TIMEOUT, async (t) => {
  const f = await fixture(t, [{ tool: "read", args: { path: "source.png" } }, {}]);
  const original = await noisyPng(4000, 3000);
  await writeFile(f.path, original);
  const port = await f.factory();
  let structured: unknown;
  const unsubscribe = port.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "read") {
      structured = (event.result as { structuredContent?: unknown }).structuredContent;
    }
  });
  t.after(unsubscribe);
  await port.prompt("Read the large screenshot");
  await port.waitTurn?.();
  const tool = (await history(port.sessionFile)).find((message) => message.role === "toolResult");
  assert.ok(tool && tool.role === "toolResult");
  const final = imageOf(tool.content);
  const decoded = await resizeImage(Buffer.from(final.data, "base64"), final.mimeType);
  assert.ok(decoded);
  assert.ok(decoded.originalWidth < 2000 || decoded.originalHeight < 1500);
  const notes = text(tool.content).match(/\[Image: original [^\]]+\]/g);
  assert.deepEqual(notes, [
    `[Image: original 4000x3000, displayed at ${decoded.originalWidth}x${decoded.originalHeight}. Multiply coordinates by ${(4000 / decoded.originalWidth).toFixed(2)} to map to original image.]`,
  ]);
  assert.deepEqual(
    f.bodies[1]!.messages.filter((message) => message.role === "tool").flatMap(
      (message) => text(message.content).match(/\[Image: original [^\]]+\]/g) ?? [],
    ),
    notes,
  );
  assert.equal(urls(f.bodies[1]!)[0], `data:${final.mimeType};base64,${final.data}`);
  assert.ok(structured && typeof structured === "object" && "data" in structured);
  assert.equal(structured.data, final.data);
  assert.ok(f.diagnostics[0]!.inputBase64Bytes > BUDGET);
  assertCompressed(urls(f.bodies[1]!)[0]!);
  assert.deepEqual(await readFile(f.path), original);
});

test("invalid prompt and Read images retain SDK omission notices", TIMEOUT, async (t) => {
  const f = await fixture(t, [{ tool: "read", args: { path: "source.png" } }, {}]);
  const invalid = (await sourcePng).subarray(0, 64);
  await writeFile(f.path, invalid);
  const port = await f.factory();
  await port.prompt("Read the invalid screenshot", {
    images: [{ ...f.image, data: invalid.toString("base64") }],
  });
  await port.waitTurn?.();
  assert.ok(f.bodies.every((body) => urls(body).length === 0));
  const messages = await history(port.sessionFile);
  const user = messages.find((message) => message.role === "user");
  const tool = messages.find((message) => message.role === "toolResult");
  assert.ok(user && Array.isArray(user.content));
  assert.ok(tool && tool.role === "toolResult");
  assert.match(text(user.content), /image.*(omitted|failed|unable|could not)/i);
  assert.match(text(tool.content), /image.*(omitted|failed|unable|could not)/i);
  assert.equal(f.diagnostics[0]?.failedImages, 1);
  assert.deepEqual(await readFile(f.path), invalid);
});

for (const disabled of [true, false]) {
  test(
    disabled
      ? "autoResize=false preserves user and tool image bytes"
      : "invalid tool image is retained with failure diagnostic",
    TIMEOUT,
    async (t) => {
      const f = await fixture(t, [{ tool: "mcp__fixture__screenshot" }, {}], !disabled);
      const image = disabled
        ? f.image
        : { ...f.image, data: Buffer.from("invalid generated pixels").toString("base64") };
      const session = await f.sdk([imageTools(image)]);
      await session.prompt("Return generated image", disabled ? { images: [image] } : undefined);
      const sent = urls(f.bodies[1]!);
      assert.equal(sent.length, disabled ? 2 : 1);
      assert.ok(sent.every((url) => url === `data:${image.mimeType};base64,${image.data}`));
      const tool = (await history(session.sessionFile!)).find(
        (message) => message.role === "toolResult",
      );
      assert.ok(tool && tool.role === "toolResult");
      assert.deepEqual(imageOf(tool.content), image);
      if (disabled) assert.equal(f.diagnostics.length, 0);
      else {
        assert.equal(f.diagnostics[0]?.failedImages, 1);
        assert.equal(f.diagnostics[0]?.outputBase64Bytes, image.data.length);
        assert.doesNotMatch(JSON.stringify(f.diagnostics), new RegExp(image.data));
      }
    },
  );
}
