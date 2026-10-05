import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePiMcpFiles, toPiStoredMcpServer } from "@zcode/shared/node";
import { registerableMcpServers } from "./pi-mcp.js";

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
