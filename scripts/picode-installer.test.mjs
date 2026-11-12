import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installScriptSource } from "./picode-distribution/installer.mjs";

const run = promisify(execFile);
// Git Bash 的 POSIX 路径也避免 GNU tar 将 Windows 盘符解释为远程主机。
const shellPath = (path) =>
  path.replaceAll("\\", "/").replace(/^([a-z]):/iu, (_, drive) => `/${drive.toLowerCase()}`);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-installer-"));
  const bin = join(root, "commands");
  const install = join(root, "installation");
  const tools = join(root, "tools");
  const source = join(root, "source", "picode", "bin");
  await Promise.all([mkdir(bin), mkdir(tools), mkdir(source, { recursive: true })]);
  await writeFile(
    join(source, "picode.mjs"),
    'console.log("new-runner", ...process.argv.slice(2));\n',
  );
  await copyFile(
    resolve("scripts/picode-distribution/legacy-runner.mjs"),
    join(source, "zcode.mjs"),
  );
  const curl = `#!/bin/sh
case "$*" in
 *latest.json*) printf '%s' '{"version":"1.0.0","tarball":"fixture.tar.gz"}' ;;
 *) while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then shift; cp "$PICODE_TEST_ARCHIVE" "$1"; exit; fi
      shift
    done
    exit 1 ;;
esac
`;
  await writeFile(join(tools, "curl"), curl, { mode: 0o755 });
  await writeFile(join(root, "install.sh"), installScriptSource("https://fixture.invalid/picode"));
  await run("tar", ["-czf", "fixture.tar.gz", "-C", "source", "picode"], {
    cwd: root,
    timeout: 10_000,
  });
  const env = {
    ...process.env,
    PATH: `${tools}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    ZCODE_DIST_HOME: shellPath(install),
    ZCODE_DIST_BIN_DIR: shellPath(bin),
    PICODE_TEST_ARCHIVE: shellPath(join(root, "fixture.tar.gz")),
    TMPDIR: shellPath(root),
  };
  return {
    root,
    bin,
    install,
    installRelease: () =>
      run("sh", [shellPath(join(root, "install.sh"))], { env, timeout: 15_000 }),
    wrapper: (name) =>
      `#!/usr/bin/env sh\nexec node "${shellPath(install)}/current/bin/${name}.mjs" "$@"\n`,
    invoke: (name) => run("sh", [shellPath(join(bin, name)), "--help"], { env, timeout: 10_000 }),
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

for (const legacy of ["absent", "owned", "third-party", "symlink"]) {
  test(`installer preserves legacy ${legacy} command and supports repeated installation`, async () => {
    const f = await fixture();
    try {
      const legacyPath = join(f.bin, "zcode");
      const foreign = join(f.root, "foreign");
      if (legacy === "owned") await writeFile(legacyPath, f.wrapper("zcode"));
      // Windows junction 不等价于 POSIX symlink；真实 current 升级在 Linux 上执行。
      if (legacy === "owned" && process.platform !== "win32") {
        const old = join(f.install, "releases", "0.9.0");
        await mkdir(join(old, "bin"), { recursive: true });
        await writeFile(join(old, "bin", "zcode.mjs"), 'console.log("old-runner");\n');
        await symlink(
          old,
          join(f.install, "current"),
          process.platform === "win32" ? "junction" : "dir",
        );
        assert.match((await f.invoke("zcode")).stdout, /old-runner/u);
      }
      if (legacy === "third-party") await writeFile(legacyPath, "third-party-command\n");
      if (legacy === "symlink") {
        await mkdir(foreign);
        await writeFile(join(foreign, "sentinel"), "unchanged");
        await symlink(foreign, legacyPath, process.platform === "win32" ? "junction" : "dir");
      }
      const before = ["owned", "third-party"].includes(legacy)
        ? await readFile(legacyPath, "utf8")
        : null;
      for (let i = 0; i < 2; i++) {
        await f.installRelease();
        assert.match((await f.invoke("picode")).stdout, /new-runner --help/u);
        if (legacy === "owned")
          assert.match((await f.invoke("zcode")).stdout, /new-runner --help/u);
        if (before !== null) assert.equal(await readFile(legacyPath, "utf8"), before);
        if (legacy === "absent") await assert.rejects(lstat(legacyPath), { code: "ENOENT" });
        if (legacy === "symlink") {
          assert.ok((await lstat(legacyPath)).isSymbolicLink());
          assert.ok(await readlink(legacyPath));
          assert.equal(await readFile(join(foreign, "sentinel"), "utf8"), "unchanged");
        }
      }
    } finally {
      await f.dispose();
    }
  });
}

for (const collision of ["file", "symlink"]) {
  test(`installer refuses an unrelated picode ${collision} before switching current`, async () => {
    const f = await fixture();
    try {
      const command = join(f.bin, "picode");
      const target = join(f.root, "foreign");
      if (collision === "file") await writeFile(command, "third-party-command\n");
      else {
        await mkdir(target);
        await writeFile(join(target, "sentinel"), "unchanged");
        await symlink(target, command, process.platform === "win32" ? "junction" : "dir");
      }
      await assert.rejects(f.installRelease(), (error) => {
        assert.match(error.stderr, /already exists/u);
        return true;
      });
      await assert.rejects(lstat(join(f.install, "current")), { code: "ENOENT" });
      if (collision === "file")
        assert.equal(await readFile(command, "utf8"), "third-party-command\n");
      else {
        assert.ok((await lstat(command)).isSymbolicLink());
        assert.equal(await readFile(join(target, "sentinel"), "utf8"), "unchanged");
      }
    } finally {
      await f.dispose();
    }
  });
}
