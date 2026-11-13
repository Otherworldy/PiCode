import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { runZcodeSubagent } from "./host-capabilities.js";
import { getPiSdkStatus } from "./pi-sdk.js";
import { requestDiagnosticLogLevel, type RequestDiagnostic } from "./request-diagnostics.js";
import { createSdkSessionFactory } from "./session-factory.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test(
  "main and child diagnostics match real local SDK requests and complete once",
  { timeout: 30_000 },
  async (t) => {
    const base = process.platform === "win32" ? "D:/tmp" : tmpdir();
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, "picode-request-diagnostics-"));
    const bodies: string[] = [];
    const diagnostics: RequestDiagnostic[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push(raw);
      if (bodies.length === 1) {
        res.writeHead(500, { "content-type": "application/json", "retry-after-ms": "1" });
        res.end(JSON.stringify({ error: { message: "generated retry", type: "server_error" } }));
        return;
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
      const childRead =
        raw.includes("child-read") && !body.messages.some((message) => message.role === "tool");
      const delta = childRead
        ? {
            tool_calls: [
              {
                index: 0,
                id: "image-read",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "test.png" }) },
              },
            ],
          }
        : { content: "ok" };
      const chunk = {
        id: "local",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: childRead ? "tool_calls" : "stop" }],
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    server.requestTimeout = 15_000;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    await writeFile(join(dir, "test.png"), Buffer.from(PNG, "base64"));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        retry: { enabled: false, provider: { maxRetries: 1 } },
        compaction: { enabled: false },
        cacheWarming: "off",
      }),
    );
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "mock-test-key",
            models: [
              {
                id: "diagnostic-model",
                name: "Local mock",
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
    const runtime = await ModelRuntime.create({
      modelsPath,
      credentials: new InMemoryCredentialStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const onRequestDiagnostic = (entry: RequestDiagnostic) => diagnostics.push(entry);
    const createPort = createSdkSessionFactory({
      agentDir,
      modelRuntime: runtime,
      onRequestDiagnostic,
    });
    const sessionInput = {
      cwd: dir,
      sessionId: "diagnostic-main",
      sessionFile: join(dir, "main.jsonl"),
      loadExtensions: false,
      checkPermission: async () => "allow" as const,
    };
    const port = await createPort(sessionInput);
    t.after(async () => {
      await port.abort();
      await port.dispose();
    });
    await port.bindUi?.({});
    await port.setModel?.("mock", "diagnostic-model", "off");
    await port.prompt("检查生成的图片", {
      images: [{ type: "image", data: PNG, mimeType: "image/png" }],
    });
    await port.waitTurn?.();
    await port.prompt("Reuse the same active context");
    await port.waitTurn?.();
    const result = await runZcodeSubagent({
      cwd: dir,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModel("mock", "diagnostic-model"),
      thinkingLevel: "off",
      parentSessionFile: port.sessionFile,
      parentSessionId: port.sessionId,
      profile: {
        name: "reader",
        description: "Read test image",
        systemPrompt: "Read images",
        tools: ["read"],
      },
      task: "child-read test.png",
      check: async () => "allow",
      signal: t.signal,
      onRequestDiagnostic,
    });
    assert.match(result, /ok/);
    await port.dispose();
    SessionManager.open(port.sessionFile).appendCompaction("Generated context summary", null, 1000);
    const compacted = await createPort(sessionInput);
    t.after(async () => {
      await compacted.abort();
      await compacted.dispose();
    });
    await compacted.bindUi?.({});
    await compacted.setModel?.("mock", "diagnostic-model", "off");
    await compacted.prompt("Only the active summary is visible");
    await compacted.waitTurn?.();
    assert.ok((await readFile(port.sessionFile, "utf8")).includes(PNG));
    const prepared = diagnostics.filter((entry) => entry.phase === "prepared");
    const settled = diagnostics.filter((entry) => entry.phase === "settled");
    assert.equal(bodies.length, 6);
    assert.equal(bodies[0], bodies[1]);
    const acceptedRequests = bodies.slice(1);
    assert.equal(prepared.length, acceptedRequests.length);
    assert.equal(settled.length, acceptedRequests.length);
    for (const [index, entry] of prepared.entries()) {
      assert.equal(entry.payloadJsonBytes, Buffer.byteLength(acceptedRequests[index]!));
      const end = settled[index]!;
      assert.equal(end.requestIndex, entry.requestIndex);
      assert.equal(end.outcome, "completed");
      assert.equal(end.correlation, "session_request");
      assert.equal(end.modelSource, "provider_event");
      assert.equal(end.responseStatus, 200);
      assert.ok(end.durationMs! >= end.responseHeadersMs!);
      assert.ok(end.durationMs! >= end.firstContentMs!);
      assert.ok(end.firstContentMs! >= end.responseHeadersMs!);
      if (index !== 2) {
        assert.ok(end.durationMs! >= end.firstTextMs!);
        assert.ok(end.firstTextMs! >= end.responseHeadersMs!);
      } else {
        assert.equal(end.firstTextMs, undefined);
      }
      assert.equal(end.sdkSource, getPiSdkStatus().active);
      assert.ok(end.sdkVersion.length > 0);
      assert.equal(typeof end.usage?.input, "number");
      assert.equal(typeof end.usage?.output, "number");
      assert.equal(typeof end.usage?.cacheRead, "number");
      assert.equal(typeof end.usage?.cacheWrite, "number");
    }
    assert.equal(prepared[0]?.contextImageCount, 1);
    assert.equal(prepared[1]?.contextImageCount, 1);
    assert.equal(prepared[2]?.contextImageCount, 0);
    assert.equal(prepared[3]?.contextImageCount, 1);
    assert.equal(prepared[4]?.contextImageCount, 0);
    assert.doesNotMatch(acceptedRequests[4]!, /iVBORw0KGgo/);
    assert.equal(prepared[3]?.parentSessionId, port.sessionId);
    assert.notEqual(prepared[3]?.sessionId, prepared[0]?.sessionId);
    assert.equal(requestDiagnosticLogLevel(prepared[0]!), "info");
    assert.equal(requestDiagnosticLogLevel(prepared[2]!), "debug");
    assert.equal(
      requestDiagnosticLogLevel({ ...prepared[2]!, payloadJsonBytes: 1024 * 1024 }),
      "info",
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /检查生成的图片|mock-test-key|iVBORw0KGgo|test\.png/,
    );
    assert.equal(await readFile(join(dir, "test.png"), "base64"), PNG);
  },
);
