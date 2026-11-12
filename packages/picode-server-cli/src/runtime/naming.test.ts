import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stageRelease } from "../packaging/stage.js";
import { resolveHostTarCommand } from "../packaging/tarCommand.js";
import { createDaemonServiceDescriptor, type ServicePlatform } from "../platform/serviceManager.js";
import { createRuntimeManifest, type ServerTarget } from "./manifest.js";
import { resolveServerLayout, stablePathId } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { writeStableLauncher } from "./stableLauncher.js";

const run = promisify(execFile);

test("Agent and Server packages register distinct primary commands", async () => {
  const server = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const agent = JSON.parse(
    await readFile(
      new URL("../../../../apps/picode-cli/packages/cli/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(server.bin), ["picode-server"]);
  assert.ok(agent.bin.picode);
  assert.equal(agent.bin.picode, agent.bin.zcode);
});

async function temporaryRoot(): Promise<string> {
  const parent = tmpdir();
  await mkdir(parent, { recursive: true });
  return await mkdtemp(join(parent, "picode-server-naming-"));
}

for (const platform of ["linux", "darwin", "win32"] satisfies ServicePlatform[]) {
  test(`stable ${platform} launchers share the current root and service identity`, async () => {
    const root = await temporaryRoot();
    try {
      const layout = resolveServerLayout(join(root, "server root"));
      const primary = platform === "win32" ? "picode-server.cmd" : "picode-server";
      const legacy = platform === "win32" ? "zcode.cmd" : "zcode";
      const primaryPath = await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: join(root, "bootstrap.js"),
      });
      assert.equal(primaryPath, join(layout.stableBinDir, primary));
      const content = await readFile(primaryPath, "utf8");
      assert.equal(await readFile(join(layout.stableBinDir, legacy), "utf8"), content);
      assert.ok(content.includes("current.json"));
      assert.ok(content.includes("server-cli.js"));
      assert.ok(content.includes("bootstrap.js"));
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      assert.equal(descriptor.name, `com.zhipu.zcode.server.${stablePathId(layout.serverRoot)}`);
      assert.ok(descriptor.content.includes(primary));
      if (platform === "win32") {
        assert.equal(JSON.parse(descriptor.content).command, primaryPath);
      } else if (process.platform !== "win32") {
        assert.equal((await stat(primaryPath)).mode & 0o111, 0o111);
      }
      await writeStableLauncher(layout, platform);
      const updated = await readFile(primaryPath, "utf8");
      assert.equal(await readFile(join(layout.stableBinDir, legacy), "utf8"), updated);
      assert.ok(!updated.includes("bootstrap.js"));
      assert.deepEqual((await readdir(layout.stableBinDir)).sort(), [primary, legacy].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const target of ["linux-x64", "win32-x64"] satisfies ServerTarget[]) {
  test(`staging ${target} creates the primary launcher and preserves runtime identities`, async () => {
    const root = await temporaryRoot();
    try {
      const dist = join(root, "dist");
      const dependency = join(root, "node_modules", "fixture");
      await mkdir(dist, { recursive: true });
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, "package.json"), '{"name":"fixture"}');
      await writeFile(join(dist, "server-cli.js"), 'import "fixture";');
      await writeFile(join(dist, "server-core.js"), "// core fixture\n");
      await writeFile(join(root, "agent.cjs"), "// agent fixture\n");
      await writeFile(join(root, "node"), "node fixture\n");
      const staged = await stageRelease({
        target,
        appVersion: "1.2.3",
        distDir: dist,
        agentBundlePath: join(root, "agent.cjs"),
        nodeBinaryPath: join(root, "node"),
        notices: { thirdParty: "fixture", node: "fixture", nodeSource: "fixture" },
        workspaceNodeModulesDir: join(root, "node_modules"),
        outputDir: join(root, "output"),
        archive: target === "win32-x64",
      });
      assert.equal(basename(staged.releaseDir), `picode-server-${target}`);
      const launcher = target.startsWith("win32-") ? "picode-server.cmd" : "picode-server";
      assert.deepEqual(await readdir(join(staged.releaseDir, "bin")), [launcher]);
      const content = await readFile(join(staged.releaseDir, "bin", launcher), "utf8");
      assert.ok(content.includes("server-cli.js"));
      assert.ok(content.includes(target.startsWith("win32-") ? "node.exe" : "runtime/node"));
      assert.equal(
        await readFile(join(staged.releaseDir, "runtime", "zcode.cjs"), "utf8"),
        "// agent fixture\n",
      );
      const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8"));
      assert.equal(manifest.product, "zcode-server");
      assert.equal(manifest.entrypoints.agent, "runtime/zcode.cjs");
      if (staged.archivePath) {
        assert.equal(basename(staged.archivePath), `picode-server-${target}.zip`);
        const layout = resolveServerLayout(join(root, "installed"));
        const installed = await new ReleaseInstaller(layout).installArchive({
          archivePath: staged.archivePath,
          target,
          version: "1.2.3",
        });
        assert.equal(await readFile(join(installed.releaseDir, "bin", launcher), "utf8"), content);
        assert.equal(
          await readFile(join(layout.stableBinDir, "picode-server.cmd"), "utf8"),
          await readFile(join(layout.stableBinDir, "zcode.cmd"), "utf8"),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("installer accepts legacy archives and rejects mixed roots without changing pending release", async () => {
  const root = await temporaryRoot();
  try {
    const source = join(root, "source");
    const legacyName = "zcode-server-win32-x64";
    const newName = "picode-server-win32-x64";
    await mkdir(join(source, legacyName), { recursive: true });
    await writeFile(
      join(source, legacyName, "manifest.json"),
      JSON.stringify(createRuntimeManifest("win32-x64", "1.2.3")),
    );
    await writeFile(join(source, "._metadata"), "resource fork fixture");
    const archive = join(root, "legacy.zip");
    const archiveSource = async (path: string) => {
      if (process.platform === "win32") {
        await run(resolveHostTarCommand(), ["-acf", path, "."], { cwd: source, timeout: 30_000 });
      } else {
        await run("zip", ["-qr", path, "."], { cwd: source, timeout: 30_000 });
      }
    };
    await archiveSource(archive);
    const layout = resolveServerLayout(join(root, "installed"));
    const installer = new ReleaseInstaller(layout);
    const installed = await installer.installArchive({
      archivePath: archive,
      target: "win32-x64",
      version: "1.2.3",
    });
    assert.equal(installed.version, "1.2.3");
    assert.ok(!(await readdir(installed.releaseDir)).some((name) => name.startsWith("._")));
    const pending = await readFile(layout.pendingFile, "utf8");
    await rename(join(source, legacyName), join(source, newName));
    await mkdir(join(source, legacyName));
    const mixedArchive = join(root, "mixed.zip");
    await archiveSource(mixedArchive);
    await assert.rejects(
      installer.installArchive({
        archivePath: mixedArchive,
        target: "win32-x64",
        version: "1.2.3",
      }),
      /multiple server roots/u,
    );
    assert.equal(await readFile(layout.pendingFile, "utf8"), pending);
    assert.ok(!(await readdir(layout.releasesDir)).some((name) => name.startsWith(".incoming-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
