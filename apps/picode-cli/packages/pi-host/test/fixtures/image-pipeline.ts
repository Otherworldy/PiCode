import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { deflate } from "node:zlib";
import { InMemoryCredentialStore, type ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createImageIngestionExtension,
  type SessionImageDiagnostic,
} from "../../src/image-ingestion.js";
import { getPiSdkStatus } from "../../src/pi-sdk.js";
import { createSdkSessionFactory } from "../../src/session-factory.js";

export const BUDGET = 512 * 1024;
export const TIMEOUT = { timeout: 60_000 };
export type Block = { type: string; text?: string; data?: string; image_url?: { url: string } };
type Payload = {
  messages: Array<{ role: string; content: string | Block[]; tool_call_id?: string }>;
};
type Reply = { tool?: string; args?: object; gate?: Promise<void> };

function pngChunk(name: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

export async function noisyPng(width = 720, height = 1280): Promise<Buffer> {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  let seed = 0x12345678;
  for (let row = 0; row < height; row++) {
    for (let col = 1; col < stride; col++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[row * stride + col] = seed & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", await promisify(deflate)(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
export const sourcePng = noisyPng();
export const urls = (payload: Payload) =>
  payload.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block) => (block.image_url ? [block.image_url.url] : []))
      : [],
  );
export const text = (content: string | Block[]) =>
  typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");
export const imageOf = (content: Block[]) => {
  const image = content.find((block) => block.type === "image");
  assert.ok(image?.data);
  return image as ImageContent;
};
export function assertCompressed(url: string): void {
  assert.match(url, /^data:image\/(jpeg|png);base64,/);
  const data = url.split(",")[1]!;
  assert.ok(Buffer.byteLength(data) <= BUDGET, `encoded bytes: ${data.length}`);
  assert.ok(Buffer.from(data, "base64").length > 0);
}

export async function fixture(t: TestContext, replies: Reply[] = [], autoResize = true) {
  const base = process.platform === "win32" ? "D:/tmp" : tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "picode-image-pipeline-"));
  const agentDir = join(dir, "agent");
  const bodies: Payload[] = [],
    diagnostics: SessionImageDiagnostic[] = [];
  const received = Promise.withResolvers<void>();
  const sessions: Array<{ abort(): Promise<void>; dispose(): void | Promise<void> }> = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Payload);
      const index = bodies.length - 1;
      received.resolve();
      const reply = replies[index];
      await reply?.gate;
      const delta = reply?.tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${index}`,
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) },
              },
            ],
          }
        : { content: "ok" };
      const chunk = JSON.stringify({
        id: `mock-${index}`,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: reply?.tool ? "tool_calls" : "stop" }],
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${chunk}\n\ndata: [DONE]\n\n`);
    } catch {
      res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  t.after(async () => {
    for (const session of sessions) {
      await session.abort();
      await session.dispose();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await mkdir(agentDir);
  const settings = {
    retry: { enabled: false },
    compaction: { enabled: false },
    images: { autoResize },
  };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  const modelsPath = join(dir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "local-test",
          models: [
            {
              id: "image-model",
              name: "Image mock",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 200_000,
              maxTokens: 64,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    modelsPath,
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel("mock", "image-model");
  assert.ok(model);
  const bytes = await sourcePng;
  const image: ImageContent = {
    type: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
  };
  const path = join(dir, "source.png");
  await writeFile(path, bytes);
  const observe = (entry: SessionImageDiagnostic) => diagnostics.push(entry);
  return {
    dir,
    agentDir,
    bodies,
    received: received.promise,
    diagnostics,
    modelRuntime,
    model,
    image,
    path,
    async factory(sessionFile = join(dir, "session.jsonl")) {
      const port = await createSdkSessionFactory({
        agentDir,
        modelRuntime,
        onImageDiagnostic: observe,
      })({
        sessionId: "image-parent",
        cwd: dir,
        sessionFile,
        loadExtensions: false,
        checkPermission: async () => "allow",
      });
      sessions.push(port);
      await port.bindUi?.({});
      assert.equal(await port.setModel?.("mock", "image-model", "off"), true);
      assert.equal(getPiSdkStatus().builtinVersion, "1.5.0");
      return port;
    },
    async sdk(extra: InlineExtension[] = []) {
      const settingsManager = SettingsManager.inMemory(settings);
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        extensionFactories: [
          createImageIngestionExtension({
            autoResize: () => settingsManager.getImageAutoResize(),
            onDiagnostic: observe,
          }),
          ...extra,
        ],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir,
        model,
        modelRuntime,
        thinkingLevel: "off",
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.create(dir, dir),
      });
      sessions.push(session);
      await session.bindExtensions({
        mode: "print",
        onError: (error) => assert.fail(JSON.stringify(error)),
      });
      return session;
    },
  };
}

export function imageTools(image: ImageContent): InlineExtension {
  return {
    name: "generated-image-tools",
    factory(pi) {
      const parameters = { type: "object", properties: {} } as ToolDefinition["parameters"];
      pi.registerTool({
        name: "mcp__fixture__screenshot",
        label: "Screenshot",
        description: "Generated pixels",
        outputSchema: {
          type: "object",
          properties: {
            status: { type: "string" },
            frames: { type: "number" },
          },
          required: ["status", "frames"],
        } as ToolDefinition["outputSchema"],
        parameters,
        async execute() {
          return {
            content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }],
            details: {},
            structuredContent: { status: "captured", frames: 1 },
          };
        },
      });
      pi.registerTool({
        name: "nested_image",
        label: "Nested",
        description: "Call screenshot",
        parameters,
        async execute(_id, _args, signal, _update, ctx) {
          const outcome = await ctx.executeTool("mcp__fixture__screenshot", {}, { signal });
          assert.equal(outcome.isError, false);
          assert.deepEqual(outcome.result.structuredContent, { status: "captured", frames: 1 });
          return outcome.result;
        },
      });
    },
  };
}

export async function history(file: string) {
  return SessionManager.open(file).buildSessionContext().messages;
}
