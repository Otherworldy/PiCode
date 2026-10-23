import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const WORKSPACE = "/example/retention-ws";
const DAY_MS = 24 * 60 * 60 * 1000;

function meta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}` as ZCodeTaskMeta["traceId"],
    workspacePath: WORKSPACE,
    title: taskId,
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 2,
  } as ZCodeTaskMeta;
}

async function withRepo(run: (repo: TaskIndexRepo, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-retention-"));
  const dbPath = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  try {
    await run(repo, dbPath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function ageTask(dbPath: string, taskId: string, updatedAt: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE task_id = ?`).run(updatedAt, taskId);
  } finally {
    db.close();
  }
}

function countRows(dbPath: string, taskId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(1) AS c FROM tasks WHERE task_id = ?`).get(taskId) as {
      c: number;
    };
    return row.c;
  } finally {
    db.close();
  }
}

test("过期 tombstone 被物理删除", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({ meta: meta("gone"), deleted: true, searchableText: "要清理的正文" });
    await repo.syncTaskMeta({ meta: meta("live") });
    ageTask(dbPath, "gone", Date.now() - 40 * DAY_MS);

    const removed = await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS });

    assert.equal(removed, 1);
    assert.equal(countRows(dbPath, "gone"), 0);
    assert.equal(countRows(dbPath, "live"), 1, "未删除的行不能被清掉");
  });
});

test("未到保留期的 tombstone 保留（undo / 分支图谱还要读它）", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({ meta: meta("fresh"), deleted: true });
    ageTask(dbPath, "fresh", Date.now() - 1 * DAY_MS);

    const removed = await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS });

    assert.equal(removed, 0);
    assert.equal(countRows(dbPath, "fresh"), 1);
  });
});

test("仍被分组引用的 tombstone 不被删除", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({ meta: meta("grouped"), deleted: true });
    ageTask(dbPath, "grouped", Date.now() - 40 * DAY_MS);

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare(`SELECT workspace_key AS k FROM tasks WHERE task_id = ?`).get(
        "grouped",
      ) as { k: string };
      // task_group_members 有指到 task_groups 的外键，必须先建组。
      db.prepare(
        `INSERT INTO task_groups (group_id, title, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("g1", "分组", "gray", 1, 1);
      db.prepare(
        `INSERT INTO task_group_members (
           group_id, workspace_key, workspace_path, workspace_identity,
           task_id, sort_order, added_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("g1", row.k, WORKSPACE, null, "grouped", 0, 1, 1, 1);
    } finally {
      db.close();
    }

    const removed = await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS });

    assert.equal(removed, 0, "带分组引用的行必须留下，否则 grouped 视图会抛「包含不可见 task」");
    assert.equal(countRows(dbPath, "grouped"), 1);
  });
});

test("重复清理是幂等的", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({ meta: meta("gone"), deleted: true });
    ageTask(dbPath, "gone", Date.now() - 40 * DAY_MS);

    assert.equal(await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS }), 1);
    assert.equal(await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS }), 0);
  });
});

test("清理后 tombstone 不再被列表读到", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({
      meta: meta("searchable"),
      deleted: true,
      searchableText: "独有的标记词 zzprunedzz",
    });
    ageTask(dbPath, "searchable", Date.now() - 40 * DAY_MS);

    // queryTaskList 硬编码排除 tombstone，tombstone 的唯一读路径是 deleted 过滤。
    const before = await repo.listTaskMetas({ workspacePath: WORKSPACE, deleted: true });
    assert.deepEqual(
      before.map((row) => row.taskId),
      ["searchable"],
      "清理前分支图谱仍能读到 tombstone",
    );

    await repo.pruneDeletedTasks({ olderThanMs: 30 * DAY_MS });

    const after = await repo.listTaskMetas({ workspacePath: WORKSPACE, deleted: true });
    assert.deepEqual(after, []);
  });
});
