import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createSdkSessionFactory,
  mountPiHostExtensions,
  withBuiltinSearchTools,
} from "./session-factory.js";

test("a conversation branch still mounts host extensions", () => {
  assert.equal(mountPiHostExtensions({ isolated: false, loadExtensions: true }), true);
  assert.equal(
    mountPiHostExtensions({ isolated: false, loadExtensions: true, omitHostExtensions: false }),
    true,
  );
  assert.equal(
    mountPiHostExtensions({ isolated: false, loadExtensions: true, omitHostExtensions: true }),
    false,
  );
  assert.equal(mountPiHostExtensions({ isolated: true, loadExtensions: true }), false);
  assert.equal(mountPiHostExtensions({ isolated: false, loadExtensions: false }), false);
});

test("unloading an override extension still leaves builtin search tools", () => {
  assert.deepEqual(withBuiltinSearchTools(["read", "bash", "edit", "write"], ["grep", "find", "ls"]), [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
  assert.deepEqual(withBuiltinSearchTools(["read", "grep"], ["grep"]), ["read", "grep"]);
});

test("extension tools are sent upstream with PiCode tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ext-tools-"));
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const chunk = JSON.stringify({
        id: "mock",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${chunk}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const agentDir = join(dir, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "probe.ts"),
      `export default function (pi) {
        pi.registerTool({
          name: "probe_extension_tool",
          label: "Probe",
          description: "Extension probe",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
      }
`,
    );
    await writeFile(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "test",
            models: [
              {
                id: "mock-model",
                name: "Mock",
                reasoning: false,
                input: ["text"],
                contextWindow: 8000,
                maxTokens: 64,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      modelsPath: join(dir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const session = await createSdkSessionFactory({
      agentDir,
      modelRuntime,
      capabilities: {
        listSubagents: async () => [],
      },
    })({
      sessionId: "ext-tools",
      cwd: dir,
      sessionFile: join(dir, "session.jsonl"),
      loadExtensions: true,
      checkPermission: async () => "allow",
    });
    await session.setModel?.("mock", "mock-model", "off");
    await session.prompt("Reply with ok.");
    await session.waitTurn?.();
    session.dispose();
    const payload = JSON.parse(bodies[0] ?? "{}") as {
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = (payload.tools ?? []).map((tool) => tool.function?.name);
    assert.ok(names.includes("probe_extension_tool"), names.join(","));
    assert.ok(names.includes("read"));
    assert.ok(names.includes("picode_subagent"));
    assert.ok(names.includes("grep") && names.includes("find") && names.includes("ls"));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
