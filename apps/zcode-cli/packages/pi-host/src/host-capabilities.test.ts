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

test("capability tools call PiCode subagents", async () => {
  const calls: string[] = [];
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    sessionId: "sess_browser",
    ports: {
      listSubagents: async () => [
        { name: "Explore", description: "search", systemPrompt: "look" },
      ],
    },
    runSubagent: async (profile, task) => {
      calls.push(`${profile.name}:${task}`);
      return "done";
    },
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["picode_subagent"],
  );
  const subagent = tools[0]?.execute(
    "1",
    { agent: "Explore", task: "find it" },
    undefined,
    undefined,
    undefined as never,
  );
  const subagentResult = await subagent;
  assert.equal(subagentResult.content[0]?.text, "done");
  assert.ok(calls.includes("Explore:find it"));
});
