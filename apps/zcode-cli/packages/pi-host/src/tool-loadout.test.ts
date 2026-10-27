import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePlannotatorToolActive, type ToolLoadoutPort } from "./tool-loadout.js";

function session(active: string[], registered: string[]): ToolLoadoutPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    getToolDefinition: (name: string) => (registered.includes(name) ? { name } : undefined),
    getActiveToolNames: () => active,
    setActiveToolsByName: (names: string[]) => calls.push(names),
  };
}

test("a registered plannotator tool is declared again", () => {
  const port = session(["read"], ["read", "plannotator"]);
  assert.equal(ensurePlannotatorToolActive(port), true);
  assert.deepEqual(port.calls, [["read", "plannotator"]]);
});

test("an already declared plannotator tool is left alone", () => {
  const port = session(["read", "plannotator"], ["plannotator"]);
  assert.equal(ensurePlannotatorToolActive(port), false);
  assert.deepEqual(port.calls, []);
});

test("an unregistered tool is not invented", () => {
  // 用户关掉了插件的 agentTool 开关，工具根本没注册。
  const port = session(["read"], ["read"]);
  assert.equal(ensurePlannotatorToolActive(port), false);
  assert.deepEqual(port.calls, []);
});
