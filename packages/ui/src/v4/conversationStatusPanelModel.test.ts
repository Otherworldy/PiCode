import assert from "node:assert/strict";
import test from "node:test";
import type { GitRepositorySummary } from "@zcode/shared";
import {
  buildConversationStatusPanelModel,
  planFromPlannotatorProgress,
} from "./conversationStatusPanelModel.js";

function repository(branchName: string): GitRepositorySummary {
  return {
    workspacePath: `D:/repo/.worktrees/${branchName}`,
    repoRoot: `D:/repo/.worktrees/${branchName}`,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 1,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  };
}

test("plannotator progress widget fills the todo list when plan is empty", () => {
  const widgets = [
    {
      key: "plannotator-progress",
      lines: ["☑ 画背景", "☐ 画自行车", "☐ 画鹈鹕"],
    },
  ];
  const parsed = planFromPlannotatorProgress(widgets);
  assert.deepEqual(
    parsed?.items.map((item) => [item.content, item.status]),
    [
      ["画背景", "completed"],
      ["画自行车", "inProgress"],
      ["画鹈鹕", "pending"],
    ],
  );
  const model = buildConversationStatusPanelModel({ extensionWidgets: widgets });
  assert.equal(model.plan?.completedCount, 1);
  assert.equal(model.plan?.totalCount, 3);
  const kept = buildConversationStatusPanelModel({
    extensionWidgets: widgets,
    plan: {
      updatedAt: 1,
      items: [{ id: "todo-1", content: "旧 TodoWrite", status: "pending" }],
    },
  });
  assert.equal(kept.plan?.items[0]?.content, "旧 TodoWrite");
});

test("git repositories keep the git tool even when the worktree is clean", () => {
  const gitSummary = repository("todo-1");
  const shown = buildConversationStatusPanelModel({
    gitSummary,
    gitWorktreeChangeSummary: { added: 0, removed: 0 },
  });
  assert.equal(shown.git?.branchName, "todo-1");
  assert.equal(shown.git?.added, 0);
  assert.equal(shown.hasContent, true);

  const office = buildConversationStatusPanelModel({
    isOfficeMode: true,
    gitSummary,
  });
  assert.equal(office.git, null);
});

test("dirty files with no line stats still show the git tool", () => {
  const gitSummary = {
    ...repository("main"),
    workspacePath: "D:/repo",
    repoRoot: "D:/repo",
    isDirty: true,
  };
  const shown = buildConversationStatusPanelModel({
    gitSummary,
    gitDirtyFileCount: 2,
    gitWorktreeChangeSummary: { added: 0, removed: 0 },
  });
  assert.equal(shown.git?.dirtyFileCount, 2);
  assert.equal(shown.git?.added, 0);
  assert.equal(shown.git?.isClean, false);
  assert.equal(shown.hasContent, true);
});
