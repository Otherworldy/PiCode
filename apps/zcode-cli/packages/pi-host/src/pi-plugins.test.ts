import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyZcodePluginPlan,
  listPiPlugins,
  setPiPluginEnabled,
  zcodePluginSourceId,
} from "./pi-plugins.js";

test("lists and toggles Pi packages and extension files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugins-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  const pkgDir = join(root, "local-pkg");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(agentDir, "extensions", "demo.ts"), "export default function () {}\n");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [pkgDir] }),
  );

  const listed = await listPiPlugins(cwd, agentDir, root);
  const pkg = listed.find((row) => row.kind === "package");
  const ext = listed.find((row) => row.kind === "extension");
  assert.equal(pkg?.enabled, true);
  assert.equal(pkg?.scope, "user");
  assert.equal(ext?.detail, "extensions/demo.ts");
  assert.equal(ext?.enabled, true);

  await setPiPluginEnabled(cwd, pkg!.id, false, agentDir, root);
  await setPiPluginEnabled(cwd, ext!.id, false, agentDir, root);
  const saved = await readFile(join(agentDir, "settings.json"), "utf8");
  assert.equal(saved, JSON.stringify({ packages: [pkgDir] }));
  const switches = JSON.parse(await readFile(join(root, "pi-plugin-switches.json"), "utf8")) as Record<
    string,
    boolean
  >;
  assert.equal(switches[pkg!.id], false);
  assert.equal(switches[ext!.id], false);

  const after = await listPiPlugins(cwd, agentDir, root);
  assert.equal(after.find((row) => row.id === pkg!.id)?.enabled, false);
  assert.equal(after.find((row) => row.id === ext!.id)?.enabled, false);
  const info = {
    origin: "package",
    source: pkgDir,
    scope: "user",
  };
  assert.equal(zcodePluginSourceId(info, pkgDir), pkg!.id);
  const extensions = [
    { path: pkgDir, sourceInfo: info },
    {
      path: join(agentDir, "extensions", "demo.ts"),
      sourceInfo: {
        origin: "top-level",
        source: "auto",
        scope: "user",
        baseDir: agentDir,
      },
    },
  ];
  applyZcodePluginPlan(
    {
      getExtensions: () => ({ extensions }),
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({ prompts: [] }),
    },
    { extensionPaths: [], skillPaths: [], promptPaths: [], disabled: new Set([pkg!.id, ext!.id]) },
  );
  assert.equal(extensions.length, 0);
});
