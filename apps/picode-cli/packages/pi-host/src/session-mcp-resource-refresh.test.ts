import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiMcpRuntimeServer } from "./pi-mcp.js";
import { createSdkSessionFactory } from "./session-factory.js";
import type { PiSessionPort } from "./types.js";

test(
  "SDK reload refreshes runtime MCP and lazy Chrome configuration without eager connection",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "picode-mcp-resource-refresh-"));
    let session: PiSessionPort | undefined;
    t.after(async () => {
      try {
        await session?.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    // 只提供工具名让懒启动等待立即完成，不启动浏览器或 MCP transport。
    await writeFile(
      join(agentDir, "extensions", "fixture-tools.js"),
      `
export default pi => pi.registerTool({
  name: "mcp__chrome_devtools__probe", label: "Fixture", description: "Local fixture",
  parameters: { type: "object", properties: {} },
  async execute() { return { content: [], details: {} }; }
});
`,
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let servers: PiMcpRuntimeServer[] = [
      { name: "fixture_runtime", config: { command: "fixture-v1", args: ["v1"] } },
    ];
    let calls = 0;
    let sdk: AgentSession | undefined;
    const originalReload = AgentSession.prototype.reload;
    t.mock.method(
      AgentSession.prototype,
      "reload",
      async function (this: AgentSession, ...args: Parameters<AgentSession["reload"]>) {
        // Test spy needs the receiver to inspect the runtime rebuilt by SDK reload.
        // eslint-disable-next-line typescript/no-this-alias
        sdk = this;
        return originalReload.apply(this, args);
      },
    );
    session = await createSdkSessionFactory({
      agentDir,
      modelRuntime: runtime,
      mcpCompat: {
        async runtimeServers() {
          calls++;
          return servers;
        },
      },
    })({
      sessionId: "mcp-resource-refresh",
      cwd: root,
      sessionFile: join(root, "session.jsonl"),
      loadExtensions: true,
      checkPermission: async () => "allow",
    });
    const reload = async () => {
      const before = calls;
      await session!.reloadResources!();
      assert.equal(calls, before + 1);
      assert.ok(sdk);
      return sdk;
    };
    const configureLazy = (mcpServers: Record<string, unknown>) =>
      writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers }));
    const registered = () =>
      sdk!.resourceLoader
        .getExtensions()
        .runtime.mcpServers.list()
        .map(({ name }) => name);
    const hints = () => sdk!.resourceLoader.getAppendSystemPrompt().join("\n");
    const args = (name: string) => {
      const config = sdk!.resourceLoader.getExtensions().runtime.mcpServers.get(name)?.config;
      return config && "args" in config ? config.args : undefined;
    };
    const activateLazy = async () => {
      const result = await sdk!.extensionRunner.emitToolCall({
        type: "tool_call",
        toolCallId: "fixture-lazy-call",
        toolName: "codemode",
        input: { code: "mcp__chrome_devtools.probe()" },
      });
      assert.notEqual(result?.block, true, JSON.stringify(result));
    };
    await reload();
    assert.deepEqual(registered(), ["fixture_runtime"]);
    assert.deepEqual(args("fixture_runtime"), ["v1"]);
    assert.doesNotMatch(hints(), /mcp__chrome_devtools/);
    servers = [{ name: "fixture_runtime", config: { command: "fixture-v2", args: ["v2"] } }];
    await configureLazy({
      "chrome-devtools": { command: "fixture-npx", args: ["chrome-devtools-mcp", "--v1"] },
    });
    await reload();
    assert.deepEqual(args("fixture_runtime"), ["v2"]);
    assert.deepEqual(registered(), ["fixture_runtime"]);
    assert.match(hints(), /mcp__chrome_devtools/);
    await activateLazy();
    assert.deepEqual(args("chrome-devtools"), ["chrome-devtools-mcp", "--v1"]);
    await configureLazy({
      "chrome-devtools": { command: "fixture-npx", args: ["chrome-devtools-mcp", "--v2"] },
    });
    await reload();
    assert.deepEqual(registered(), ["fixture_runtime"]);
    await activateLazy();
    assert.deepEqual(args("chrome-devtools"), ["chrome-devtools-mcp", "--v2"]);
    servers = [{ name: "fixture_runtime", config: { command: "fixture-v2", enabled: false } }];
    await configureLazy({
      "chrome-devtools": { command: "fixture-npx", args: ["chrome-devtools-mcp"], enabled: false },
    });
    await reload();
    await activateLazy();
    assert.deepEqual(registered(), []);
    assert.doesNotMatch(hints(), /mcp__chrome_devtools/);
    servers = [];
    await configureLazy({});
    await reload();
    await activateLazy();
    assert.deepEqual(registered(), []);
    assert.doesNotMatch(hints(), /mcp__chrome_devtools/);
  },
);
