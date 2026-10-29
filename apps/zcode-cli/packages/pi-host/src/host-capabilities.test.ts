import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCapabilityTools,
  piToolNamesForAgent,
  resolveZcodeSubagentLaunchModel,
  runZcodeSubagent,
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
