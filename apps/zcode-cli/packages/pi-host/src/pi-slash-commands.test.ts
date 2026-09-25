import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemblePiSlashCommands, listPiSlashCommands } from "./pi-slash-commands.js";

test("pi slash commands follow builtin, template, extension, then skill", () => {
  const names = assemblePiSlashCommands({
    templates: [{ name: "ship", description: "Ship it" }],
    extensions: [
      { name: "settings", description: "hidden by builtin" },
      { name: "subagents", description: "Run subagents" },
    ],
    skills: [{ name: "ponytail", description: "Be lazy" }],
    skillCommands: true,
  }).map((command) => command.name);

  assert.equal(names[0], "settings");
  assert.ok(names.indexOf("compact") < names.indexOf("ship"));
  assert.ok(names.indexOf("ship") < names.indexOf("subagents"));
  assert.ok(names.includes("skill:ponytail"));
  assert.equal(names.filter((name) => name === "settings").length, 1);
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
  assert.equal(found[0]?.name, "settings");
});
