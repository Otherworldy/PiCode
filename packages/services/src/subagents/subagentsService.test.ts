import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSubagentsService } from "./subagentsService.js";

async function builtInAgent(service: ReturnType<typeof createSubagentsService>, name: string) {
  const result = await service.list({ workspacePath: "", mode: "settingsUserOnly" });
  const agent = result.agents.find((item) => item.name === name);
  assert.ok(agent, `missing built-in agent ${name}`);
  return agent;
}

test("built-in tool override is stored, applied and cleared", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "subagents-service-"));
  const service = createSubagentsService({ homeDir, isDesktopRuntime: true });

  const before = await builtInAgent(service, "researcher");
  assert.ok(before.tools?.includes("one_search"));
  assert.equal(before.toolsOverride, undefined);

  await service.setBuiltInToolOverride({
    agentName: "researcher",
    tools: ["read", "one_search"],
  });
  const overridden = await builtInAgent(service, "researcher");
  assert.deepEqual(overridden.tools, ["read", "one_search"]);
  assert.deepEqual(overridden.toolsOverride, ["read", "one_search"]);

  const stateFile = join(homeDir, ".PiCode", "v2", "agents-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8")) as {
    builtInToolOverrides: unknown;
  };
  assert.deepEqual(state.builtInToolOverrides, {
    researcher: { tools: ["read", "one_search"] },
  });

  await service.setBuiltInToolOverride({ agentName: "researcher", tools: null });
  const cleared = await builtInAgent(service, "researcher");
  assert.equal(cleared.toolsOverride, undefined);
  assert.ok(cleared.tools?.includes("web_fetch"));
});

test("inherit and excludeTools shape the effective built-in tools", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "subagents-service-"));
  const service = createSubagentsService({ homeDir, isDesktopRuntime: true });

  await service.setBuiltInToolOverride({ agentName: "worker", tools: "inherit" });
  const inherit = await builtInAgent(service, "worker");
  assert.deepEqual(inherit.tools, ["*"]);

  await service.setBuiltInToolOverride({
    agentName: "worker",
    tools: "inherit",
    excludeTools: ["bash"],
  });
  const inheritedWithExclusion = await builtInAgent(service, "worker");
  assert.deepEqual(inheritedWithExclusion.tools, ["*"]);
  assert.deepEqual(inheritedWithExclusion.toolsExclude, ["bash"]);

  await service.setBuiltInToolOverride({
    agentName: "worker",
    tools: ["read", "bash", "edit"],
    excludeTools: ["bash"],
  });
  const narrowed = await builtInAgent(service, "worker");
  // 显式列表的排除直接应用，toolsOverride 就是生效列表。
  assert.deepEqual(narrowed.tools, ["read", "edit"]);
  assert.deepEqual(narrowed.toolsOverride, ["read", "edit"]);
  assert.equal(narrowed.toolsExclude, undefined);

  // 空数组是显式“无工具”，不是删除覆盖。
  await service.setBuiltInToolOverride({ agentName: "worker", tools: [] });
  const none = await builtInAgent(service, "worker");
  assert.deepEqual(none.tools, []);
  assert.deepEqual(none.toolsOverride, []);
});

test("unknown built-in role names are rejected instead of written as dead keys", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "subagents-service-"));
  const service = createSubagentsService({ homeDir, isDesktopRuntime: true });
  await assert.rejects(
    () =>
      service.setBuiltInToolOverride({
        agentName: "general-purpose" as never,
        tools: ["read"],
      }),
    /无效内置 Subagent 身份/,
  );
});
