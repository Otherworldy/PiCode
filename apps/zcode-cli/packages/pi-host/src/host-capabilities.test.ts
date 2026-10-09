import assert from "node:assert/strict";
import test from "node:test";
import {
  createCapabilityTools,
  piToolNamesForAgent,
  resolveZcodeSubagentLaunchModel,
  subagentDefaultModelFromSettings,
  toZcodeSubagentProfile,
} from "./host-capabilities.js";

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

test("subagent without a model inherits the parent model and thinking level", () => {
  const parent = { id: "parent-model" };
  const resolved = resolveZcodeSubagentLaunchModel({
    parentModel: parent,
    parentThinkingLevel: "high",
    getModel: () => {
      throw new Error("inherit must not look up a model");
    },
  });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.model, parent);
  assert.equal(resolved.thinkingLevel, "high");
});

test("subagent model selection replaces the parent model", () => {
  const pinned = { id: "pinned" };
  const resolved = resolveZcodeSubagentLaunchModel({
    profileModel: { providerId: "acme", modelId: "small", thought: "low" },
    defaultModel: "acme/other",
    parentModel: { id: "parent" },
    parentThinkingLevel: "high",
    getModel: (providerId, modelId) =>
      providerId === "acme" && modelId === "small" ? pinned : undefined,
  });
  assert.equal(resolved.model, pinned);
  assert.equal(resolved.thinkingLevel, "low");
});

test("an unpinned subagent uses subagents.defaultModel before the parent", () => {
  const fallback = { id: "flash" };
  const resolved = resolveZcodeSubagentLaunchModel({
    profileThought: "low",
    defaultModel: "acme/flash:medium",
    parentModel: { id: "parent" },
    parentThinkingLevel: "high",
    getModel: (providerId, modelId) =>
      providerId === "acme" && modelId === "flash" ? fallback : undefined,
  });
  assert.equal(resolved.model, fallback);
  assert.equal(resolved.thinkingLevel, "medium");
});

test("role thinking remains when neither override nor defaultModel sets it", () => {
  const resolved = resolveZcodeSubagentLaunchModel({
    profileThought: "low",
    parentModel: { id: "parent" },
    parentThinkingLevel: "high",
    getModel: () => undefined,
  });
  assert.equal(resolved.model?.id, "parent");
  assert.equal(resolved.thinkingLevel, "low");
});

test("subagents.defaultModel is read from Pi settings", () => {
  assert.equal(
    subagentDefaultModelFromSettings({ subagents: { defaultModel: " acme/flash " } }),
    "acme/flash",
  );
  assert.equal(subagentDefaultModelFromSettings({}), undefined);
});

test("missing subagent model does not fall back to the parent", () => {
  const resolved = resolveZcodeSubagentLaunchModel({
    profileModel: { providerId: "acme", modelId: "gone" },
    parentModel: { id: "parent" },
    parentThinkingLevel: "high",
    getModel: () => undefined,
  });
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.error, "model acme/gone is not available");
});

test("inherit stays unset and a saved selection keeps its thought level", () => {
  assert.deepEqual(
    toZcodeSubagentProfile({
      name: "Explore",
      description: "search",
      systemPrompt: "look",
    }),
    { name: "Explore", description: "search", systemPrompt: "look" },
  );
  assert.deepEqual(
    toZcodeSubagentProfile({
      name: "general-purpose",
      description: "work",
      systemPrompt: "do",
      modelSelection: {
        providerId: "acme",
        modelId: "small",
        options: { reasoningLevel: "low" },
      },
    }).model,
    { providerId: "acme", modelId: "small", thought: "low" },
  );
  assert.equal(
    toZcodeSubagentProfile({
      name: "scout",
      description: "recon",
      systemPrompt: "map",
      thinking: "low",
    }).thought,
    "low",
  );
});
