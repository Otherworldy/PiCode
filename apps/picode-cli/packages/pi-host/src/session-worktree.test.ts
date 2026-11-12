import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acceptedWorkingDirectory } from "./session-registry.js";

const exec = promisify(execFile);

test("acceptedWorkingDirectory only allows a registered worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-wt-"));
  try {
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "t"], { cwd: root });
    await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: root });
    const copy = join(root, ".worktrees", "bug-xxx");
    await exec("git", ["worktree", "add", "-b", "bug/xxx", copy], { cwd: root });
    assert.equal(await acceptedWorkingDirectory(root, copy), copy);
    assert.equal(await acceptedWorkingDirectory(root, join(root, "not-a-worktree")), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
