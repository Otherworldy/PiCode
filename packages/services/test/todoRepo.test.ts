import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IGitService } from "../src/git/git.js";
import { TodoStateError } from "../src/todos/todo.js";
import { TodoRepo } from "../src/todos/todoRepo.js";
import { TodoService } from "../src/todos/todoService.js";

async function withRepo(run: (repo: TodoRepo) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "todos-"));
  const repo = new TodoRepo(join(dir, "tasks-index.sqlite"));
  try {
    await run(repo);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("create requires a project and lists stay split by project", async () => {
  await withRepo(async (repo) => {
    await assert.rejects(
      () => repo.create({ title: "a", prompt: "b", workspacePath: "  " }),
      TodoStateError,
    );
    const alpha = await repo.create({
      title: "a",
      prompt: "do a",
      workspacePath: "/proj/a",
    });
    await repo.create({ title: "b", prompt: "do b", workspacePath: "/proj/b" });
    const listed = await repo.list(alpha.workspaceKey);
    assert.deepEqual(
      listed.map((item) => item.title),
      ["a"],
    );
    assert.equal(alpha.id, "todo-1");
    await repo.delete(alpha.id);
    const next = await repo.create({ title: "c", prompt: "do c", workspacePath: "/proj/a" });
    assert.equal(next.id, "todo-3");
  });
});

test("settle ignores an unknown session and one project can run many todos", async () => {
  await withRepo(async (repo) => {
    assert.equal(await repo.settle("missing", "completed"), null);
    const first = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    const second = await repo.create({ title: "b", prompt: "p", workspacePath: "/proj/a" });
    const other = await repo.create({ title: "c", prompt: "p", workspacePath: "/proj/c" });
    assert.equal(typeof (await repo.claim(first.id)) === "object", true);
    assert.equal(typeof (await repo.claim(second.id)) === "object", true);
    assert.equal(await repo.claim(first.id), "bad-status");
    assert.equal(typeof (await repo.claim(other.id)) === "object", true);
    const settled = await repo.settle("no-such-session", "failed");
    assert.equal(settled, null);
  });
});

test("nothing to merge cannot complete the merge path", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.claim(created.id);
    await repo.attachRun(created.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo/1",
      worktreePath: "/proj/a/.worktrees/todo-1",
      sessionId: "session-1",
    });
    await repo.settle("session-1", "completed");
    let merges = 0;
    const git: Pick<
      IGitService,
      | "getRepositorySummary"
      | "listWorktrees"
      | "createWorktree"
      | "removeWorktree"
      | "countCommitsAhead"
      | "mergeBranch"
    > = {
      async getRepositorySummary() {
        throw new Error("unused");
      },
      async listWorktrees() {
        return [];
      },
      async createWorktree() {
        throw new Error("unused");
      },
      async removeWorktree() {},
      async countCommitsAhead() {
        return 0;
      },
      async mergeBranch() {
        merges += 1;
        return { success: false, code: "nothing-to-merge", message: "相对基线没有提交" };
      },
    };
    const service = new TodoService(repo, git, {
      async create() {
        return { sessionId: "session-1" };
      },
      async continue() {},
    });
    await assert.rejects(() => service.merge(created.id), /没有提交/);
    assert.equal(merges, 1);
    const done = await service.complete(created.id);
    assert.equal(done.status, "done");
  });
});

test("dirty baseline commits only after commitDirty and only on the base branch", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.claim(created.id);
    await repo.attachRun(created.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-1",
      worktreePath: "/proj/a/.worktrees/todo-1",
      sessionId: "session-1",
    });
    await repo.settle("session-1", "completed");
    let branch = "main";
    let commits = 0;
    let staged: string[] = [];
    let failGenerate = false;
    const service = new TodoService(
      repo,
      {
        async getRepositorySummary() {
          return { branchName: branch } as Awaited<ReturnType<IGitService["getRepositorySummary"]>>;
        },
        async listWorktrees() {
          return [];
        },
        async createWorktree() {
          throw new Error("unused");
        },
        async removeWorktree() {},
        async countCommitsAhead() {
          return 1;
        },
        async getChanges() {
          return [{ path: "/proj/a/a.txt" }] as Awaited<ReturnType<IGitService["getChanges"]>>;
        },
        async generateCommitMessage() {
          if (failGenerate) throw new Error("model down");
          return { message: "wip", providerId: "p", model: "m" };
        },
        async stagePaths(params) {
          staged = params.paths;
        },
        async commit(params) {
          commits += 1;
          assert.equal(params.message, "wip");
          return { commitHash: "def" } as Awaited<ReturnType<IGitService["commit"]>>;
        },
        async mergeBranch() {
          if (commits === 0) {
            return { success: false, code: "dirty", message: "主工作区有未提交改动" };
          }
          return { success: true };
        },
      },
      {
        async create() {
          return { sessionId: "session-1" };
        },
        async continue() {},
      },
    );

    await assert.rejects(
      () => service.merge(created.id),
      (error: unknown) => {
        assert.equal(error instanceof TodoStateError && error.code, "dirty");
        return true;
      },
    );
    assert.equal(commits, 0);
    assert.equal((await repo.get(created.id))?.error, null);

    branch = "other";
    await assert.rejects(() => service.merge(created.id, { commitDirty: true }), /不在 main/);
    assert.equal(commits, 0);
    assert.equal((await repo.get(created.id))?.status, "needs_review");

    branch = "main";
    failGenerate = true;
    await assert.rejects(() => service.merge(created.id, { commitDirty: true }), /model down/);
    assert.equal((await repo.get(created.id))?.error, "model down");
    assert.equal(commits, 0);

    failGenerate = false;
    const done = await service.merge(created.id, { commitDirty: true });
    assert.deepEqual(staged, ["/proj/a/a.txt"]);
    assert.equal(commits, 1);
    assert.equal(done.status, "done");
    assert.equal(done.error, null);
  });
});

test("deleting a session fails a running todo and keeps review mergeable", async () => {
  await withRepo(async (repo) => {
    assert.equal(await repo.noteSessionRemoved("missing"), null);
    const running = await repo.create({ title: "run", prompt: "p", workspacePath: "/proj/a" });
    const review = await repo.create({ title: "review", prompt: "p", workspacePath: "/proj/a" });
    const done = await repo.create({ title: "done", prompt: "p", workspacePath: "/proj/a" });
    await repo.claim(running.id);
    await repo.attachRun(running.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-1",
      worktreePath: "/proj/a/.worktrees/todo-1",
      sessionId: "session-run",
    });
    await repo.claim(review.id);
    await repo.attachRun(review.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-2",
      worktreePath: "/proj/a/.worktrees/todo-2",
      sessionId: "session-review",
    });
    await repo.settle("session-review", "completed");
    await repo.claim(done.id);
    await repo.attachRun(done.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-3",
      worktreePath: "/proj/a/.worktrees/todo-3",
      sessionId: "session-done",
    });
    await repo.settle("session-done", "completed");
    await repo.markDone(done.id);

    const failed = await repo.noteSessionRemoved("session-run");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "会话已删除");
    assert.equal(failed?.sessionId, null);
    assert.equal(failed?.worktreePath, "/proj/a/.worktrees/todo-1");
    assert.equal(await repo.noteSessionRemoved("session-run"), null);

    const stillReview = await repo.noteSessionRemoved("session-review");
    assert.equal(stillReview?.status, "needs_review");
    assert.equal(stillReview?.error, "会话已删除");
    assert.equal(stillReview?.sessionId, null);
    assert.equal(stillReview?.worktreePath, "/proj/a/.worktrees/todo-2");

    const stillDone = await repo.noteSessionRemoved("session-done");
    assert.equal(stillDone?.status, "done");
    assert.equal(stillDone?.sessionId, null);
    assert.equal(stillDone?.error, null);
  });
});

test("a removed session starts again on the same worktree", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.claim(created.id);
    await repo.attachRun(created.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-1",
      worktreePath: "/proj/a/.worktrees/todo-1",
      sessionId: "session-1",
    });
    await repo.noteSessionRemoved("session-1");
    let worktrees = 0;
    let continued = 0;
    const git: Pick<
      IGitService,
      | "getRepositorySummary"
      | "listWorktrees"
      | "createWorktree"
      | "removeWorktree"
      | "countCommitsAhead"
      | "mergeBranch"
    > = {
      async getRepositorySummary() {
        throw new Error("unused");
      },
      async listWorktrees() {
        return [];
      },
      async createWorktree() {
        worktrees += 1;
        throw new Error("unused");
      },
      async removeWorktree() {},
      async countCommitsAhead() {
        return 0;
      },
      async mergeBranch() {
        throw new Error("unused");
      },
    };
    const selection = { providerId: "p", modelId: "m", options: { reasoningLevel: "low" } };
    let seen = false;
    const service = new TodoService(repo, git, {
      async create(input) {
        seen = input.modelSelection.modelId === selection.modelId;
        return { sessionId: "session-2" };
      },
      async continue() {},
    });
    const next = await service.start(created.id, selection);
    assert.equal(seen, true);
    assert.equal(worktrees, 0);
    assert.equal(continued, 0);
    assert.equal(next.status, "running");
    assert.equal(next.sessionId, "session-2");
    assert.equal(next.worktreePath, "/proj/a/.worktrees/todo-1");
  });
});

test("tags stay in the catalog after the todo is deleted", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({
      title: "a",
      prompt: "p",
      workspacePath: "/proj/a",
      tags: [" Bug ", "bug", "Feature"],
    });
    assert.deepEqual(created.tags, ["Bug", "Feature"]);
    await repo.delete(created.id);
    assert.deepEqual(await repo.listTags(), ["Bug", "Feature"]);
    await repo.claim(
      (await repo.create({ title: "b", prompt: "p", workspacePath: "/proj/a", tags: ["feature"] }))
        .id,
    );
    const running = await repo.list("/proj/a");
    const tagged = await repo.setTags(running[0]!.id, ["x"]);
    assert.equal(tagged.status, "running");
    assert.deepEqual(tagged.tags, ["x"]);
    assert.deepEqual(await repo.listTags(), ["Bug", "Feature", "x"]);
    await assert.rejects(
      () => repo.setTags(tagged.id, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
      TodoStateError,
    );
  });
});

test("retry sends the chosen model on the existing session", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.claim(created.id);
    await repo.attachRun(created.id, {
      baseBranch: "main",
      baseCommit: "abc",
      branchName: "todo-1",
      worktreePath: "/proj/a/.worktrees/todo-1",
      sessionId: "session-1",
    });
    await repo.markFailed(created.id, "中断");
    const selection = { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } };
    let seen: unknown;
    const service = new TodoService(
      repo,
      {
        async getRepositorySummary() {
          throw new Error("unused");
        },
        async listWorktrees() {
          return [];
        },
        async createWorktree() {
          throw new Error("unused");
        },
        async removeWorktree() {},
        async countCommitsAhead() {
          return 0;
        },
        async mergeBranch() {
          throw new Error("unused");
        },
      },
      {
        async create() {
          throw new Error("unused");
        },
        async continue(input) {
          seen = input.modelSelection;
        },
      },
    );
    const next = await service.start(created.id, selection);
    assert.deepEqual(seen, selection);
    assert.equal(next.sessionId, "session-1");
    assert.equal("modelSelection" in next, false);
  });
});

test("only an unstarted todo can change its text", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    const updated = await repo.update(created.id, { title: "  b  ", prompt: " q " });
    assert.equal(updated.title, "b");
    assert.equal(updated.prompt, "q");
    assert.equal(updated.status, "todo");
    await repo.claim(created.id);
    await assert.rejects(
      () => repo.update(created.id, { title: "c", prompt: "d" }),
      TodoStateError,
    );
    const kept = await repo.get(created.id);
    assert.equal(kept?.title, "b");
  });
});

test("restore puts an abandoned todo back in the queue", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.abandon(created.id);
    const restored = await repo.restore(created.id);
    assert.equal(restored?.status, "todo");
    await assert.rejects(() => repo.restore(created.id), TodoStateError);
  });
});
