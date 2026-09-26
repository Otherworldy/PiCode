import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityTools, piToolNamesForAgent } from "./host-capabilities.js";

test("agent tool names map onto Pi tools", () => {
  const available = ["read", "grep", "find", "ls", "bash", "edit", "write"];
  assert.deepEqual(piToolNamesForAgent(["*"], available), available);
  assert.deepEqual(piToolNamesForAgent(["Read", "Grep", "Glob"], available), [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  assert.deepEqual(piToolNamesForAgent(["WebSearch"], available), []);
});

test("capability tools call PiCode subagents and MCP", async () => {
  const calls: string[] = [];
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    sessionId: "sess_browser",
    reservedNames: ["read"],
    ports: {
      listSubagents: async () => [
        { name: "Explore", description: "search", systemPrompt: "look" },
      ],
      listMcpTools: async () => [
        {
          name: "read",
          serverName: "skip",
          toolName: "read",
          inputSchema: { type: "object" },
        },
        {
          name: "mcp__docs__search",
          description: "search docs",
          serverName: "docs",
          toolName: "search",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      callMcpTool: async (input) => {
        calls.push(
          `${input.serverName}/${input.toolName}:${input.sessionId}:${JSON.stringify(input.arguments)}`,
        );
        return { text: "hit" };
      },
      useMcp: async (input) => {
        calls.push(`proxy:${input.server ?? "list"}`);
        return { text: "docs" };
      },
    },
    runSubagent: async (profile, task) => {
      calls.push(`${profile.name}:${task}`);
      return "done";
    },
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["zcode_subagent", "mcp", "mcp__docs__search"],
  );
  const subagent = tools[0]?.execute("1", { agent: "Explore", task: "find it" }, undefined, undefined, undefined as never);
  const proxy = tools[1]?.execute("2", {}, undefined, undefined, undefined as never);
  const mcp = tools[2]?.execute("3", { q: "x" }, undefined, undefined, undefined as never);
  const [subagentResult, proxyResult, mcpResult] = await Promise.all([subagent, proxy, mcp]);
  assert.equal(subagentResult.content[0]?.text, "done");
  assert.equal(proxyResult.content[0]?.text, "docs");
  assert.equal(mcpResult.content[0]?.text, "hit");
  assert.ok(calls.includes("Explore:find it"));
  assert.ok(calls.includes("proxy:list"));
  assert.ok(calls.some((call) => call.startsWith("docs/search:sess_browser:")));
});
