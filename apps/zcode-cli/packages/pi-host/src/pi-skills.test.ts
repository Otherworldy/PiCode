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
