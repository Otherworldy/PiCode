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
    await assert.rejects(() => repo.create({ title: "a", prompt: "b", workspacePath: "  " }), TodoStateError);
    const alpha = await repo.create({
      title: "a",
      prompt: "do a",
      workspacePath: "/proj/a",
    });
    await repo.create({ title: "b", prompt: "do b", workspacePath: "/proj/b" });
    const listed = await repo.list(alpha.workspaceKey);
    assert.deepEqual(listed.map((item) => item.title), ["a"]);
  });
});

test("settle ignores an unknown session and a second start is per project", async () => {
  await withRepo(async (repo) => {
    assert.equal(await repo.settle("missing", "completed"), null);
    const first = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    const second = await repo.create({ title: "b", prompt: "p", workspacePath: "/proj/a" });
    const other = await repo.create({ title: "c", prompt: "p", workspacePath: "/proj/c" });
    assert.equal((await repo.claim(first.id)) !== "busy", true);
    assert.equal(await repo.claim(second.id), "busy");
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

test("restore puts an abandoned todo back in the queue", async () => {
  await withRepo(async (repo) => {
    const created = await repo.create({ title: "a", prompt: "p", workspacePath: "/proj/a" });
    await repo.abandon(created.id);
    const restored = await repo.restore(created.id);
    assert.equal(restored?.status, "todo");
    await assert.rejects(() => repo.restore(created.id), TodoStateError);
  });
});
