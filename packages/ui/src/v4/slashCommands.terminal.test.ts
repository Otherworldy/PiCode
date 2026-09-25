import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalOnlySlashCommand } from "./slashCommands.js";

const commands = [
  { name: "settings", source: "builtin" as const },
  { name: "compact", source: "builtin" as const },
  { name: "subagents", source: "custom" as const },
];

test("terminal-only pi commands are not sent to the model", () => {
  assert.equal(isTerminalOnlySlashCommand("/settings", commands), true);
  assert.equal(isTerminalOnlySlashCommand("/compact", commands), false);
  assert.equal(isTerminalOnlySlashCommand("/subagents list", commands), false);
  assert.equal(isTerminalOnlySlashCommand("/plan", commands), false);
});
