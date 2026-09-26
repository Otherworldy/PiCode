import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemblePiSlashCommands, listPiSlashCommands } from "./pi-slash-commands.js";

test("pi slash commands keep gui builtins, then prompts, then extensions", () => {
  const commands = assemblePiSlashCommands({
    templates: [{ name: "ship", description: "Ship it" }],
    extensions: [
      { name: "compact", description: "hidden by builtin" },
      { name: "subagents", description: "Run subagents" },
      { name: "skill:ponytail", description: "skill is not a command" },
      { name: "ps:kill", description: "tui process kill" },
    ],
  });
  const names = commands.map((command) => command.name);

  assert.equal(names[0], "compact");
  assert.equal(names.includes("copy"), false);
  assert.equal(names.includes("new"), false);
  assert.equal(names.includes("resume"), false);
  assert.equal(names.includes("skill:ponytail"), false);
  assert.equal(names.includes("ps:kill"), false);
  assert.ok(names.indexOf("compact") < names.indexOf("ship"));
  assert.ok(names.indexOf("ship") < names.indexOf("subagents"));
  assert.equal(commands.find((command) => command.name === "ship")?.source, "custom");
  assert.equal(commands.find((command) => command.name === "subagents")?.source, "extension");
  assert.equal(names.filter((name) => name === "compact").length, 1);
});

test("pi slash commands read prompt files without a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-slash-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(agentDir, "prompts", "ship.md"),
    "---\ndescription: Ship the change\nargument-hint: <note>\n---\n",
  );

  const found = await listPiSlashCommands(cwd, agentDir);
  const ship = found.find((command) => command.name === "ship");
  assert.equal(ship?.description, "Ship the change");
  assert.equal(ship?.inputHint, "/ship <note>");
  assert.equal(found[0]?.name, "compact");
  assert.equal(found.some((command) => command.name === "copy"), false);
});
