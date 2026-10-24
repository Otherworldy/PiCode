import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitAutoRefreshWatchPaths,
  gitAutoRefreshDueAt,
  gitAutoRefreshWatchRequest,
  shouldPollGitWorkspaceContent,
} from "./gitAutoRefresh.js";

test("git auto refresh waits for a quiet gap, then caps a long burst", () => {
  const first = gitAutoRefreshDueAt({
    now: 1_000,
    burstStartedAt: null,
    quietMs: 1_000,
    maxWaitMs: 5_000,
  });
  assert.equal(first.burstStartedAt, 1_000);
  assert.equal(first.dueAt, 2_000);

  const mid = gitAutoRefreshDueAt({
    now: 1_200,
    burstStartedAt: first.burstStartedAt,
    quietMs: 1_000,
    maxWaitMs: 5_000,
  });
  assert.equal(mid.dueAt, 2_200);

  const capped = gitAutoRefreshDueAt({
    now: 5_500,
    burstStartedAt: first.burstStartedAt,
    quietMs: 1_000,
    maxWaitMs: 5_000,
  });
  assert.equal(capped.dueAt, 6_000);
});

test("git content poll runs only when the workspace itself is not watched recursively", () => {
  assert.equal(
    shouldPollGitWorkspaceContent([{ path: "D:/repo/.git", recursive: true }], "D:/repo"),
    true,
  );
  assert.equal(
    shouldPollGitWorkspaceContent(
      [
        { path: "D:/repo", recursive: true },
        { path: "D:/repo/.git", recursive: true },
      ],
      "D:/repo",
    ),
    false,
  );
});

test("git auto refresh watch ignores node_modules", () => {
  assert.deepEqual(gitAutoRefreshWatchRequest({ path: "D:/repo", recursive: true }), {
    path: "D:/repo",
    recursive: true,
    ignoreDirectoryNames: ["node_modules"],
  });
});

test("工作区根永远不进 fs.watch，旧 remote server 下发的递归项也被丢弃", () => {
  // 递归监视工作区会让 node_modules / 生成目录的每次写入都回调 Host；
  // 非递归也一样没有意义（只报顶层文件名，脏状态判定仍要靠轮询）。
  assert.deepEqual(
    buildGitAutoRefreshWatchPaths({
      workspacePath: "D:/repo",
      repoRoot: "D:/repo",
      isGitAvailable: true,
      isRepository: true,
      autoRefreshWatchPaths: [
        { path: "D:/repo/.git", recursive: true },
        { path: "D:/repo", recursive: true },
      ],
    }),
    [{ path: "D:/repo/.git", recursive: true }],
  );
});

test("linked worktree 的元数据目录在 workspace 之外时保留", () => {
  const paths = buildGitAutoRefreshWatchPaths({
    workspacePath: "D:/repo/wt",
    repoRoot: "D:/repo/wt",
    isGitAvailable: true,
    isRepository: true,
    autoRefreshWatchPaths: [
      { path: "D:/repo/.git", recursive: true },
      { path: "D:/repo/.git/worktrees/wt", recursive: true },
    ],
  });

  assert.deepEqual(paths, [
    { path: "D:/repo/.git", recursive: true },
    { path: "D:/repo/.git/worktrees/wt", recursive: true },
  ]);
});

test("工作区根的三种写法都被归一化丢弃", () => {
  const workspacePath = "D:/repo";
  for (const candidate of ["D:\\repo", "D:/repo/"]) {
    assert.deepEqual(
      buildGitAutoRefreshWatchPaths({
        workspacePath,
        repoRoot: workspacePath,
        isGitAvailable: true,
        isRepository: true,
        autoRefreshWatchPaths: [{ path: candidate, recursive: true }],
      }),
      [],
      `${candidate} 应当被判定为工作区根`,
    );
  }
});

test("非递归的工作区根同样被丢弃", () => {
  assert.deepEqual(
    buildGitAutoRefreshWatchPaths({
      workspacePath: "D:/repo",
      repoRoot: "D:/repo",
      isGitAvailable: true,
      isRepository: true,
      autoRefreshWatchPaths: [
        { path: "D:/repo", recursive: false },
        { path: "D:/repo/.git", recursive: true },
      ],
    }),
    [{ path: "D:/repo/.git", recursive: true }],
  );
});

test("非 git 仓库不给监听路径", () => {
  assert.deepEqual(
    buildGitAutoRefreshWatchPaths({
      workspacePath: "D:/repo",
      repoRoot: "D:/repo",
      isGitAvailable: true,
      isRepository: false,
    }),
    [],
  );
});
