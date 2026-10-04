import assert from "node:assert/strict";
import test from "node:test";
import {
  bindSessionWorktree,
  isWorkspaceWorktree,
  sessionGitDirectory,
  worktreeBranchLabel,
} from "./sessionWorktree.js";

test("worktree label and path guard stay inside the parent repo", () => {
  assert.equal(worktreeBranchLabel("D:/repo/.worktrees/bug-xxx"), "bug-xxx");
  assert.equal(isWorkspaceWorktree("D:/repo", "D:/repo/.worktrees/bug-xxx"), true);
  assert.equal(isWorkspaceWorktree("D:/repo", "D:/other/.worktrees/bug-xxx"), false);
  bindSessionWorktree("s1", "D:/repo/.worktrees/todo-1");
  assert.equal(sessionGitDirectory("D:/repo", "s1"), "D:/repo/.worktrees/todo-1");
  assert.equal(sessionGitDirectory("D:/repo", "other"), "D:/repo");
  assert.equal(sessionGitDirectory("D:/repo", null), "D:/repo");
});
