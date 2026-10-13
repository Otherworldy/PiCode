import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePiMcpFiles, toPiStoredMcpServer } from "@zcode/shared/node";
import {
  isLazyChromeDevtoolsConfig,
  loadLazyChromeDevtoolsServers,
  loadZcodeMcpConfig,
  registerableMcpServers,
} from "./pi-mcp.js";
import {
  chromeDevtoolsToolWantsServer,
  ensureLazyChromeDevtools,
} from "./chrome-devtools-lazy.js";

test("directTools becomes Pi direct exposure and SSE is dropped", () => {
  const stored = toPiStoredMcpServer({
    type: "stdio",
    command: "node",
    args: ["server.js"],
    directTools: true,
    timeoutMs: 1500,
  });
  assert.equal(stored?.exposure, "direct");
  assert.equal(stored?.directTools, undefined);
  assert.equal(stored?.timeout, 2);
  assert.equal(toPiStoredMcpServer({ type: "sse", url: "https://example.com/sse" }), undefined);
  assert.deepEqual(
    registerableMcpServers([
      { name: "node_repl", config: { type: "stdio", command: "node", directTools: true } },
      { name: "bad name", config: { command: "node" } },
      { name: "off", config: { command: "node", enabled: false } },
    ]).map((server) => server.name),
    ["node_repl"],
  );
});

test("an empty Pi mcp.json still receives the legacy servers once", () => {
  const cwd = mkdtempSync(join(tmpdir(), "zcode-mcp-migrate-"));
  const legacyDir = join(cwd, ".PiCode");
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(legacyDir, "config.json"),
    JSON.stringify({ mcp: { servers: { docs: { command: "node", args: ["s.js"] } } } }),
  );
  const target = join(cwd, ".pi", "mcp.json");
  writeFileSync(target, JSON.stringify({ settings: { toolPrefix: "server" }, mcpServers: {} }));
  const agentDir = join(cwd, "agent");
  ensurePiMcpFiles({ agentDir, cwd });
  const imported = JSON.parse(readFileSync(target, "utf8")) as {
    settings?: { toolPrefix?: string };
    mcpServers?: Record<string, { command?: string }>;
  };
  assert.equal(imported.settings?.toolPrefix, "server");
  assert.equal(imported.mcpServers?.docs?.command, "node");
  imported.mcpServers = {};
  writeFileSync(target, JSON.stringify(imported));
  ensurePiMcpFiles({ agentDir, cwd });
  const again = JSON.parse(readFileSync(target, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.deepEqual(again.mcpServers, {});
  assert.equal(existsSync(`${target}.zcode-imported`), true);
});

test("chrome-devtools-mcp is omitted until a codemode call names it", () => {
  assert.equal(
    isLazyChromeDevtoolsConfig({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    }),
    true,
  );
  assert.equal(
    isLazyChromeDevtoolsConfig({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      exposure: "direct",
    }),
    false,
  );
  assert.equal(chromeDevtoolsToolWantsServer("codemode", { code: "mcp__chrome_devtools.list()" }), true);
  assert.equal(chromeDevtoolsToolWantsServer("codemode", { code: "searchTools()" }), false);
  assert.equal(chromeDevtoolsToolWantsServer("bash", { command: "npx chrome-devtools-mcp" }), false);

  const cwd = mkdtempSync(join(tmpdir(), "zcode-lazy-chrome-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
        docs: { url: "https://example.com/mcp" },
      },
    }),
  );
  assert.deepEqual(
    loadZcodeMcpConfig(agentDir, cwd).servers.map((server) => server.name),
    ["docs"],
  );
  assert.deepEqual(
    loadLazyChromeDevtoolsServers(agentDir, cwd).map((server) => server.name),
    ["chrome-devtools"],
  );
});

test("lazy chrome-devtools registers once and waits until its tools exist", async () => {
  const tools: { name: string }[] = [];
  let registrations = 0;
  let now = 0;
  await ensureLazyChromeDevtools(
    {
      registerMcpServer() {
        registrations += 1;
        tools.push({ name: "mcp__chrome_devtools__list_pages" });
      },
      getAllTools: () => tools,
    },
    [{ name: "chrome-devtools", config: { command: "npx" } as never }],
    {
      now: () => now,
      sleep: async () => {
        now += 50;
      },
    },
  );
  assert.equal(registrations, 1);
});
