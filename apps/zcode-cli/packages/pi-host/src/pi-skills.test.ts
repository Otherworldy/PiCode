import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPiSkills } from "./pi-skills.js";

test("pi skill discovery includes user, project, and agents dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "skills", "user-skill"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
  await mkdir(join(cwd, ".agents", "skills", "agents-skill"), { recursive: true });
  const skill = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n`;
  await writeFile(join(agentDir, "skills", "user-skill", "SKILL.md"), skill("user-skill", "user"));
  await writeFile(
    join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
    skill("project-skill", "project"),
  );
  await writeFile(
    join(cwd, ".agents", "skills", "agents-skill", "SKILL.md"),
    skill("agents-skill", "agents"),
  );

  const found = new Map((await listPiSkills(cwd, agentDir)).map((skill) => [skill.name, skill.scope]));
  assert.equal(found.get("user-skill"), "user");
  assert.equal(found.get("project-skill"), "project");
  assert.equal(found.get("agents-skill"), "project");
});

test("disabled Pi package skills are omitted from the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-switch-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const hidden = join(root, "hidden-pack");
  const kept = join(root, "kept-pack");
  await mkdir(join(hidden, "skills", "hidden-skill"), { recursive: true });
  await mkdir(join(kept, "skills", "kept-skill"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;
  await writeFile(join(hidden, "skills", "hidden-skill", "SKILL.md"), skill("hidden-skill"));
  await writeFile(join(kept, "skills", "kept-skill", "SKILL.md"), skill("kept-skill"));
  await writeFile(join(hidden, "package.json"), JSON.stringify({ pi: { skills: ["./skills"] } }));
  await writeFile(join(kept, "package.json"), JSON.stringify({ pi: { skills: ["./skills"] } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [hidden, kept] }));
  await writeFile(
    join(root, "pi-plugin-switches.json"),
    JSON.stringify({ [`pkg:user:${hidden}`]: false }),
  );

  const found = new Set((await listPiSkills(cwd, agentDir, root)).map((item) => item.name));
  assert.equal(found.has("hidden-skill"), false);
  assert.equal(found.has("kept-skill"), true);
});
