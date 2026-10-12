import assert from "node:assert/strict";
import test from "node:test";
import { gitAutoRefreshDueAt, shouldPollGitWorkspaceContent } from "./gitAutoRefresh.js";

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
