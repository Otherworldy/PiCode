import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateTerminalTitle,
  resolveTerminalDisplayLabel,
  terminalBranchNameForCwd,
} from "./terminalPanelState.js";

const main = {
  isRepository: true,
  workspacePath: "D:/repo",
  branchName: "main",
};

test("terminal branch label follows its own cwd, not the parent checkout", () => {
  assert.equal(terminalBranchNameForCwd(main, "D:/repo/.worktrees/todo-23"), null);
  assert.equal(
    terminalBranchNameForCwd(
      {
        isRepository: true,
        workspacePath: "D:\\repo\\.worktrees\\todo-23\\",
        branchName: " todo-23 ",
      },
      "d:/repo/.worktrees/todo-23",
    ),
    "todo-23",
  );
  assert.equal(
    terminalBranchNameForCwd({ ...main, isRepository: false, branchName: "main" }, "D:/repo"),
    null,
  );
  assert.equal(terminalBranchNameForCwd({ ...main, branchName: "  " }, "D:/repo"), null);
});

test("terminal title prefers the branch and keeps later tabs unique", () => {
  assert.equal(resolveTerminalDisplayLabel("todo/23", "ZCode"), "todo/23");
  assert.equal(resolveTerminalDisplayLabel("  ", "ZCode"), "ZCode");
  assert.equal(resolveTerminalDisplayLabel(null, "todo-23"), "todo-23");
  const used = new Set(["todo-23"]);
  assert.equal(allocateTerminalTitle("todo-23", used), "todo-23 2");
  assert.equal(allocateTerminalTitle("  ", new Set()), "Terminal");
});
