import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import {
  mergeWorktreeBranches,
  parseWorktreeList,
  rewriteUnbornWorktreeBranchMiss,
} from "../src/git/repo/gitCliHelpers.js";

const execFileAsync = promisify(execFile);

test("parseWorktreeList parses porcelain worktree output correctly", () => {
  const sample = `
worktree /home/user/project
HEAD 268809a4c47459774d55259aa248c3d04b7f9df1
branch refs/heads/main

worktree /home/user/project/.worktrees/feature-x
HEAD 8a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b
branch refs/heads/feature-x
locked

worktree /home/user/project/.worktrees/detached-branch
HEAD 11223344556677889900aabbccddeeff11223344
detached
prunable gitdir file points to non-existent location
`;

  const worktrees = parseWorktreeList(sample);
  assert.equal(worktrees.length, 3);

  assert.equal(worktrees[0]?.path, "/home/user/project");
  assert.equal(worktrees[0]?.head, "268809a4c47459774d55259aa248c3d04b7f9df1");
  assert.equal(worktrees[0]?.branch, "main");
  assert.equal(worktrees[0]?.bare, false);

  assert.equal(worktrees[1]?.path, "/home/user/project/.worktrees/feature-x");
  assert.equal(worktrees[1]?.branch, "feature-x");
  assert.equal(worktrees[1]?.locked, true);

  assert.equal(worktrees[2]?.path, "/home/user/project/.worktrees/detached-branch");
  assert.equal(worktrees[2]?.branch, null);
  assert.equal(worktrees[2]?.prunable, true);
});

test("unborn worktree branches still appear in the branch list", () => {
  const branches = mergeWorktreeBranches(
    [],
    [
      {
        path: "D:/Study/Code/Demo/test",
        head: "0000000000000000000000000000000000000000",
        branch: "master",
        bare: false,
      },
      {
        path: "D:/Study/Code/Demo/test/.worktrees/feature-hello",
        head: "0000000000000000000000000000000000000000",
        branch: "feature/hello",
        bare: false,
      },
    ],
    "master",
  );
  assert.deepEqual(
    branches.map((branch) => [branch.name, branch.isCurrent]),
    [
      ["master", true],
      ["feature/hello", false],
    ],
  );
});

test("unborn head is not passed as a worktree start point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wt-unborn-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    const created = await createGitCliRepo().createWorktree(dir, "todo/unborn", {
      worktreePath: join(dir, ".worktrees", "todo-unborn"),
      startPoint: "0000000000000000000000000000000000000000",
    });
    assert.equal(created.success, true, created.issues[0]?.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unborn worktree branch is not reported as missing", () => {
  const issues = rewriteUnbornWorktreeBranchMiss(
    [{ code: "target-branch-not-found", message: "Target branch was not found." }],
    [
      {
        path: "D:/repo/.worktrees/feature-hello",
        head: "0000000000000000000000000000000000000000",
        branch: "feature/hello",
        bare: false,
      },
    ],
    "feature/hello",
  );
  assert.equal(issues[0]?.code, "branch-in-other-worktree");
  assert.equal(issues[0]?.detail, "D:/repo/.worktrees/feature-hello");
});
