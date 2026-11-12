import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCapabilityTools,
  normalizeSubagentThought,
  parseRequestedSubagentModel,
  piToolNamesForAgent,
  resolveZcodeSubagentLaunchModel,
  runZcodeSubagent,
  subagentDefaultModelFromSettings,
  thoughtLevelsOf,
  toZcodeSubagentProfile,
  type ZcodeSubagentModel,
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
  // 内置名只从 available 取，SSH 工作区不会落回本机 bash。
  assert.deepEqual(piToolNamesForAgent(["Bash"], ["read", "exec"]), []);
  // powershell 也是本机内置工具，同样不能透传到 SSH 子会话。
  assert.deepEqual(piToolNamesForAgent(["powershell"], ["read", "exec"]), []);
  // Pi 原名按精确名处理：勾了 bash 就只声明 bash，不会连带 powershell。
  assert.deepEqual(piToolNamesForAgent(["bash"], ["bash", "powershell"]), ["bash"]);
  // Claude 风格别名保留原有的兼容展开。
  assert.deepEqual(piToolNamesForAgent(["Bash"], ["bash", "powershell"]), ["bash", "powershell"]);
  // 空数组是显式“无工具”，与 pi-subagents 一致。
  assert.deepEqual(piToolNamesForAgent([], available), []);
  // `inherit` 等同通配。
  assert.deepEqual(piToolNamesForAgent(["inherit"], available), available);
  // 通配时要减掉排除表。
  assert.deepEqual(piToolNamesForAgent(["*"], available, ["bash"]), [
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
  ]);
});

test("web tool names go into the subagent allowlist", () => {
  const available = ["read", "bash", "edit", "write"];
  // 联网工具由用户扩展注册，不在 available 里也要留在白名单。
  assert.deepEqual(piToolNamesForAgent(["WebSearch"], available), ["one_search"]);
  assert.deepEqual(piToolNamesForAgent(["Read", "web_fetch", "fetch_content"], available), [
    "read",
    "web_fetch",
  ]);
  assert.deepEqual(
    piToolNamesForAgent(["one_search", "get_search_content", "source_check"], available),
    ["one_search", "get_search_content", "source_check"],
  );
  // 扩展工具名交给 Pi 按精确名匹配，不能先转小写。
  assert.deepEqual(piToolNamesForAgent(["TodoWrite"], available), ["TodoWrite"]);
});

test("capability tools call PiCode subagents", async () => {
  const calls: string[] = [];
  const options: Array<{ signal?: AbortSignal; background?: boolean }> = [];
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    sessionId: "sess_browser",
    ports: {
      listSubagents: async () => [{ name: "Explore", description: "search", systemPrompt: "look" }],
    },
    runSubagent: async (profile, task, runOptions) => {
      calls.push(`${profile.name}:${task}`);
      options.push(runOptions);
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
  // 缺省走同步分支，父工具的 signal 照旧透传。
  assert.deepEqual(options, [{ signal: undefined }]);
});

test("run_in_background forwards the flag and drops the tool signal", async () => {
  const options: Array<{ signal?: AbortSignal; background?: boolean }> = [];
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    ports: {
      listSubagents: async () => [{ name: "Explore", description: "search", systemPrompt: "look" }],
    },
    runSubagent: async (_profile, _task, runOptions) => {
      options.push(runOptions);
      return "started in background";
    },
  });
  const controller = new AbortController();
  const result = await tools[0]?.execute(
    "2",
    { agent: "Explore", task: "find it", run_in_background: true },
    controller.signal,
    undefined,
    undefined as never,
  );

  assert.equal(result.content[0]?.text, "started in background");
  // 后台派发不能绑父工具 signal：工具返回后它就没有意义了。
  assert.deepEqual(options, [{ background: true }]);
});

test("model and thought overrides reach the subagent runner", async () => {
  const options: Array<{ model?: ZcodeSubagentModel; thought?: string }> = [];
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    ports: {
      listSubagents: async () => [{ name: "worker", description: "edit", systemPrompt: "go" }],
    },
    runSubagent: async (_profile, _task, runOptions) => {
      options.push(runOptions);
      return "done";
    },
  });
  await tools[0]?.execute(
    "3",
    { agent: "worker", task: "fix", model: "acme/large", thought: " HIGH " },
    undefined,
    undefined,
    undefined as never,
  );
  await tools[0]?.execute(
    "4",
    { agent: "worker", task: "fix", model: "acme/large", thought: "high", run_in_background: true },
    undefined,
    undefined,
    undefined as never,
  );
  // 前后台同一套规则：临时模型和档位都是原样带过去。
  assert.deepEqual(options, [
    { signal: undefined, model: { providerId: "acme", modelId: "large" }, thought: "high" },
    { background: true, model: { providerId: "acme", modelId: "large" }, thought: "high" },
  ]);
});

test("inline reasoning level in model is rejected before launch", async () => {
  const tools = await createCapabilityTools({
    cwd: "D:/work",
    ports: {
      listSubagents: async () => [{ name: "worker", description: "edit", systemPrompt: "go" }],
    },
    runSubagent: async () => {
      throw new Error("must not launch");
    },
  });
  const result = await tools[0]?.execute(
    "5",
    { agent: "worker", task: "fix", model: "acme/large:high" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(result.content[0]?.text ?? "", /pass the reasoning level in thought/u);
  const bare = await tools[0]?.execute(
    "6",
    { agent: "worker", task: "fix", model: "large" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(bare.content[0]?.text ?? "", /must be provider\/model/u);
  const unknownThought = await tools[0]?.execute(
    "7",
    { agent: "worker", task: "fix", thought: "turbo" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(unknownThought.content[0]?.text ?? "", /thought "turbo" is not supported/u);
});

test("requested model and thought win over the role model", () => {
  const requested = { id: "requested" };
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "acme", modelId: "large" },
    requestedThought: "max",
    profileModel: { providerId: "acme", modelId: "small", thought: "low" },
    defaultModel: "acme/flash:medium",
    parentModel: { id: "parent" },
    parentThinkingLevel: "high",
    getModel: (providerId, modelId) =>
      providerId === "acme" && modelId === "large" ? requested : undefined,
  });
  assert.equal(resolved.model, requested);
  assert.equal(resolved.thinkingLevel, "max");
});

test("a requested model keeps the role's own thought level", () => {
  const requested = { id: "requested" };
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "acme", modelId: "large" },
    // 设置页给角色配的档位挂在被替掉的那个模型选择上，不能跟着一起消失。
    profileModel: { providerId: "acme", modelId: "small", thought: "high" },
    parentThinkingLevel: "off",
    getModel: () => requested,
  });
  assert.equal(resolved.model, requested);
  assert.equal(resolved.thinkingLevel, "high");
});

test("requested thought applies without a requested model", () => {
  const pinned = { id: "pinned" };
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedThought: "minimal",
    profileModel: { providerId: "acme", modelId: "small", thought: "low" },
    parentThinkingLevel: "high",
    getModel: () => pinned,
  });
  assert.equal(resolved.model, pinned);
  assert.equal(resolved.thinkingLevel, "minimal");
});

test("a requested thought the model does not support lists the supported levels", () => {
  const requested = { id: "flash" };
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "lens", modelId: "deepseek-v4.1-flash" },
    requestedThought: "minimal",
    parentThinkingLevel: "high",
    getModel: () => requested,
    thoughtLevelsOf: () => ["low", "high", "max"],
    describeModel: () => "lens/deepseek-v4.1-flash",
  });
  assert.equal(resolved.model, undefined);
  assert.equal(
    resolved.error,
    'thought "minimal" is not supported by lens/deepseek-v4.1-flash; supported: low, high, max',
  );
});

test("a requested thought the model supports passes through", () => {
  const requested = { id: "flash" };
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "lens", modelId: "deepseek-v4.1-flash" },
    requestedThought: "high",
    getModel: () => requested,
    thoughtLevelsOf: () => ["low", "high", "max"],
    describeModel: () => "lens/deepseek-v4.1-flash",
  });
  assert.equal(resolved.model, requested);
  assert.equal(resolved.thinkingLevel, "high");
});

test("a model that supports no level reports none", () => {
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "acme", modelId: "plain" },
    requestedThought: "low",
    getModel: () => ({ id: "plain" }),
    thoughtLevelsOf: () => [],
    describeModel: () => "acme/plain",
  });
  assert.equal(
    resolved.error,
    'thought "low" is not supported by acme/plain; supported: none',
  );
});

test("the role's own thought is not validated against the model", () => {
  // 角色档位由设置页产生，与模型目录同步；这里只管调用期覆盖，避免旧配置突然起不来。
  const pinned = { id: "small" };
  const resolved = resolveZcodeSubagentLaunchModel({
    profileModel: { providerId: "acme", modelId: "small", thought: "minimal" },
    getModel: () => pinned,
    thoughtLevelsOf: () => ["low"],
  });
  assert.equal(resolved.model, pinned);
  assert.equal(resolved.thinkingLevel, "minimal");
});

test("a requested model that is missing from the catalog fails instead of falling back", () => {
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedModel: { providerId: "acme", modelId: "gone" },
    profileModel: { providerId: "acme", modelId: "small" },
    parentModel: { id: "parent" },
    getModel: () => undefined,
  });
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.error, "model acme/gone is not available");
});

test("unknown requested thought is rejected instead of mapping to off", () => {
  const resolved = resolveZcodeSubagentLaunchModel({
    requestedThought: "turbo",
    parentModel: { id: "parent" },
    getModel: () => undefined,
  });
  assert.equal(resolved.error, 'thought "turbo" is not supported; expected off, minimal, low, medium, high, xhigh, max');
});

test("requested model parsing keeps the first slash as the provider boundary", () => {
  assert.deepEqual(parseRequestedSubagentModel(" openrouter/openai/gpt-4o "), {
    model: { providerId: "openrouter", modelId: "openai/gpt-4o" },
  });
  // ollama 的 tag 也是冒号，不能被当成内联档位。
  assert.deepEqual(parseRequestedSubagentModel("ollama/llama3:70b"), {
    model: { providerId: "ollama", modelId: "llama3:70b" },
  });
  assert.equal(parseRequestedSubagentModel("").error, "model is empty");
  assert.equal(normalizeSubagentThought("  ").thought, undefined);
  assert.equal(normalizeSubagentThought("XHigh").thought, "xhigh");
});

test("thoughtLevelsOf reads thinkingLevelMap and falls back to four levels", () => {
  assert.deepEqual(thoughtLevelsOf({ thinkingLevelMap: { off: null, low: "low", max: "max" } }), [
    "low",
    "max",
  ]);
  // 没有任何声明时按 PiCode 目录同步的默认四档算，不是“全支持”。
  assert.deepEqual(thoughtLevelsOf({}), ["off", "low", "medium", "high"]);
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

test("settings-configured tools that no extension provides fail before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-subagent-tools-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const result = await runZcodeSubagent({
    cwd: root,
    parentSessionFile: join(root, "parent.jsonl"),
    profile: {
      name: "researcher",
      description: "research",
      systemPrompt: "You are researcher.",
      source: "built-in",
      toolsSource: "override",
      tools: ["read", "one_search"],
    },
    task: "hello",
    agentDir,
    modelRuntime: undefined,
  });
  assert.match(result, /tools not available: one_search/);
});
