import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piPackageSkillSettingsScope } from "@zcode/shared";
import { listEnabledPiPackageSkillRoots } from "./piPackageSkillRoots.js";

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;

test("enabled Pi packages contribute declared skills and honor switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-skills-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "work");
  const npmRoot = join(agentDir, "npm", "node_modules", "pi-subagents");
  const localRoot = join(root, "pi-processes");
  const hiddenRoot = join(agentDir, "npm", "node_modules", "hidden-pack");
  const forcedRoot = join(agentDir, "npm", "node_modules", "forced-pack");
  const projectRoot = join(workspace, ".pi", "npm", "node_modules", "@scope", "proj");
  await mkdir(join(npmRoot, "skills", "council-mode"), { recursive: true });
  await mkdir(join(localRoot, "skills", "pi-processes"), { recursive: true });
  await mkdir(join(hiddenRoot, "skills", "hidden"), { recursive: true });
  await mkdir(join(forcedRoot, "skills", "forced"), { recursive: true });
  await mkdir(join(projectRoot, "skills", "proj-skill"), { recursive: true });
  await writeFile(join(npmRoot, "skills", "council-mode", "SKILL.md"), skill("council-mode"));
  await writeFile(join(localRoot, "skills", "pi-processes", "SKILL.md"), skill("pi-processes"));
  await writeFile(join(hiddenRoot, "skills", "hidden", "SKILL.md"), skill("hidden"));
  await writeFile(join(forcedRoot, "skills", "forced", "SKILL.md"), skill("forced"));
  await writeFile(join(projectRoot, "skills", "proj-skill", "SKILL.md"), skill("proj-skill"));
  await writeFile(
    join(npmRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["./skills"] } }),
  );
  await writeFile(
    join(localRoot, "package.json"),
    JSON.stringify({ name: "pi-processes" }),
  );
  await writeFile(
    join(hiddenRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["./skills"] } }),
  );
  await writeFile(
    join(forcedRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["./skills"] } }),
  );
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({ pi: { skills: ["./skills"] } }),
  );
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(workspace, ".pi"), { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [
        "npm:pi-subagents",
        localRoot,
        "npm:hidden-pack",
        { source: "npm:forced-pack", autoload: false },
        { source: "npm:none-pack", skills: [] },
      ],
    }),
  );
  await writeFile(
    join(workspace, ".pi", "settings.json"),
    JSON.stringify({ packages: ["npm:@scope/proj"] }),
  );
  const switchPath = join(root, "switches.json");
  await writeFile(
    switchPath,
    JSON.stringify({
      "pkg:user:npm:hidden-pack": false,
      "pkg:user:npm:forced-pack": true,
    }),
  );

  const listed = await listEnabledPiPackageSkillRoots({
    workspacePath: workspace,
    includeUserPackages: true,
    agentDir,
    switchPath,
  });
  const byPlugin = new Map(listed.map((entry) => [entry.pluginName, entry]));
  assert.equal(byPlugin.get("pi-subagents")?.path, join(npmRoot, "skills"));
  assert.equal(byPlugin.get("pi-subagents")?.scope, "user");
  assert.equal(
    piPackageSkillSettingsScope(byPlugin.get("pi-subagents")?.pluginId),
    "user",
  );
  assert.equal(byPlugin.get("pi-processes")?.path, join(localRoot, "skills"));
  assert.equal(byPlugin.get("forced-pack")?.scope, "user");
  assert.equal(byPlugin.get("proj")?.scope, "workspace");
  assert.equal(piPackageSkillSettingsScope(byPlugin.get("proj")?.pluginId), "workspace");
  assert.equal(byPlugin.has("hidden-pack"), false);
  assert.equal(byPlugin.has("none-pack"), false);

  const projectOnly = await listEnabledPiPackageSkillRoots({
    workspacePath: workspace,
    includeUserPackages: false,
    agentDir,
    switchPath,
  });
  assert.deepEqual(
    projectOnly.map((entry) => entry.pluginName),
    ["proj"],
  );
});
