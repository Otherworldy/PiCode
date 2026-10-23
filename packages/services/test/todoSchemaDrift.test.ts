import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TodoRepo } from "../src/todos/todoRepo.js";

/**
 * 旧发行版写出的 todos 表：列名 session_id → last_session_id、base_branch → base_ref。
 * 建表语句刻意不含 attachments / tags，模拟更早的迁移阶段。
 */
const LEGACY_SCHEMA = `
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_identity TEXT,
  base_ref TEXT,
  base_commit TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  error TEXT,
  last_session_id TEXT,
  merged_at INTEGER,
  unread_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 旧索引指向旧列；同名索引会让 CREATE INDEX IF NOT EXISTS 静默跳过。
CREATE INDEX idx_todos_session ON todos(last_session_id) WHERE last_session_id IS NOT NULL;
`;

function insertLegacyRow(
  dbPath: string,
  row: { id: string; lastSessionId: string | null; baseRef: string | null },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO todos (
         id, title, prompt, workspace_key, workspace_path, base_ref,
         status, last_session_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      "旧 todo",
      "旧说明",
      "/legacy/ws",
      "/legacy/ws",
      row.baseRef,
      "running",
      row.lastSessionId,
      1,
      1,
    );
  } finally {
    db.close();
  }
}

async function withLegacyRepo(run: (repo: TodoRepo, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "todos-legacy-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const seed = new DatabaseSync(dbPath);
  try {
    seed.exec(LEGACY_SCHEMA);
  } finally {
    seed.close();
  }
  const repo = new TodoRepo(dbPath);
  try {
    await run(repo, dbPath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("旧 schema 库可以打开，并且 getBySession 不再抛 no such column", async () => {
  await withLegacyRepo(async (repo, dbPath) => {
    insertLegacyRow(dbPath, { id: "todo-1", lastSessionId: "sess-old", baseRef: "main" });

    const item = await repo.getBySession("sess-old");

    assert.ok(item, "旧 last_session_id 必须能按新列名查回来");
    assert.equal(item.id, "todo-1");
    assert.equal(item.baseBranch, "main", "base_ref 必须回填到 base_branch");
  });
});

test("补列时把旧列的值搬过来，且已有的新值不被覆盖", async () => {
  await withLegacyRepo(async (repo, dbPath) => {
    insertLegacyRow(dbPath, { id: "todo-1", lastSessionId: "sess-old", baseRef: "release" });
    // 另一个来自「部分升级」状态的库：列存在但只有新值为空时才回填。
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("ALTER TABLE todos ADD COLUMN session_id TEXT");
      db.exec("ALTER TABLE todos ADD COLUMN base_branch TEXT");
      db.prepare(`UPDATE todos SET session_id = ?, base_branch = ? WHERE id = ?`).run(
        "sess-new",
        "feature",
        "todo-1",
      );
    } finally {
      db.close();
    }

    const item = await repo.getBySession("sess-new");
    assert.ok(item);
    assert.equal(item.baseBranch, "feature", "已有值不能被 legacy 值覆盖");
    assert.equal(await repo.getBySession("sess-old"), null);
  });
});

test("重复打开同一个旧库是幂等的", async () => {
  await withLegacyRepo(async (repo, dbPath) => {
    insertLegacyRow(dbPath, { id: "todo-1", lastSessionId: "sess-old", baseRef: "main" });
    assert.ok(await repo.getBySession("sess-old"));

    const second = new TodoRepo(dbPath);
    try {
      const again = await second.getBySession("sess-old");
      assert.equal(again?.id, "todo-1");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sessionIdColumns = (db.prepare("PRAGMA table_info(todos)").all() as {
          name: string;
        }[]).filter((column) => column.name === "session_id");
        assert.equal(sessionIdColumns.length, 1, "不能重复加列");
      } finally {
        db.close();
      }
    } finally {
      second.close();
    }
  });
});

test("新建的库里 session_id 也有索引（旧同名索引指向旧列，不能复用）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "todos-fresh-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new TodoRepo(dbPath);
  try {
    await repo.create({ title: "a", prompt: "b", workspacePath: "/fresh/ws" });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const indexes = (db.prepare("PRAGMA index_list(todos)").all() as { name: string }[]).map(
        (index) => index.name,
      );
      assert.ok(
        indexes.includes("idx_todos_session_id"),
        `期望存在指向 session_id 的索引，实际：${indexes.join(",")}`,
      );
    } finally {
      db.close();
    }
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
