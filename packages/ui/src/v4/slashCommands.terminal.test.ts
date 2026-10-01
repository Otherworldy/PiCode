import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalOnlySlashCommand,
  plannotatorPlanActive,
  plannotatorPlanAvailable,
} from "./slashCommands.js";

const commands = [
  { name: "settings", source: "builtin" as const },
  { name: "compact", source: "builtin" as const },
  { name: "subagents", source: "custom" as const },
];

test("terminal-only pi commands are not sent to the model", () => {
  assert.equal(isTerminalOnlySlashCommand("/settings", []), true);
  assert.equal(isTerminalOnlySlashCommand("/copy", []), true);
  assert.equal(isTerminalOnlySlashCommand("/new", []), true);
  assert.equal(isTerminalOnlySlashCommand("/compact", commands), false);
  assert.equal(isTerminalOnlySlashCommand("/subagents list", commands), false);
  assert.equal(isTerminalOnlySlashCommand("/plan", commands), false);
});

test("plan mode follows the plannotator command and status", () => {
  assert.equal(plannotatorPlanAvailable([{ name: "plannotator-plan-mode" }]), true);
  assert.equal(plannotatorPlanAvailable([{ name: "/plannotator-plan-mode" }]), true);
  assert.equal(plannotatorPlanAvailable([{ name: "compact" }]), false);
  assert.equal(plannotatorPlanActive([{ key: "plannotator" }]), true);
  assert.equal(plannotatorPlanActive([{ key: "other" }]), false);
});
