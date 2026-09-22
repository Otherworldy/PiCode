import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPiPlugins, setPiPluginEnabled } from "./pi-plugins.js";

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

  const listed = await listPiPlugins(cwd, agentDir);
  const pkg = listed.find((row) => row.kind === "package");
  const ext = listed.find((row) => row.kind === "extension");
  assert.equal(pkg?.enabled, true);
  assert.equal(pkg?.scope, "user");
  assert.equal(ext?.detail, "extensions/demo.ts");
  assert.equal(ext?.enabled, true);

  await setPiPluginEnabled(cwd, pkg!.id, false, agentDir);
  await setPiPluginEnabled(cwd, ext!.id, false, agentDir);
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
    packages: Array<{ source: string; autoload?: boolean }>;
    extensions: string[];
  };
  assert.equal(saved.packages[0]?.autoload, false);
  assert.ok(saved.extensions.includes("-extensions/demo.ts"));

  const after = await listPiPlugins(cwd, agentDir);
  assert.equal(after.find((row) => row.id === pkg!.id)?.enabled, false);
  assert.equal(after.find((row) => row.id === ext!.id)?.enabled, false);
});
