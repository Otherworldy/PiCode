import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { TodoCreateParams, TodoItem } from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { TodoStateError, workspaceKeyOf } from "#src/todos/todo.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const TODO_SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_identity TEXT,
  base_branch TEXT,
  base_commit TEXT,
  branch_name TEXT,
  worktree_path TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  attachments TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_workspace ON todos(workspace_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id) WHERE session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS todo_seq (n INTEGER NOT NULL);
`;

/** 删了不复用。旧分支可能还在，重号会检出别人的 todo-1。 */
function allocateTodoId(db: DatabaseSyncInstance): string {
  const row = db.prepare("SELECT n FROM todo_seq").get() as { n: number } | undefined;
  let n = row?.n ?? 0;
  if (!row) {
    const ids = db.prepare("SELECT id FROM todos").all() as { id: string }[];
    for (const item of ids) {
      const match = /^todo-(\d+)$/.exec(item.id);
      if (match) n = Math.max(n, Number(match[1]));
    }
    db.prepare("INSERT INTO todo_seq (n) VALUES (?)").run(n);
  }
  n += 1;
  db.prepare("UPDATE todo_seq SET n = ?").run(n);
  return `todo-${n}`;
}

interface TodoRow {
  id: string;
  title: string;
  prompt: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  base_branch: string | null;
  base_commit: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  session_id: string | null;
  status: string;
  error: string | null;
  attachments: string | null;
  created_at: number;
  updated_at: number;
}

function parseAttachments(raw: string | null): TodoItem["attachments"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TodoItem["attachments"];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toItem(row: TodoRow): TodoItem {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    workspacePath: row.workspace_path,
    ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
    workspaceKey: row.workspace_key,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    status: row.status as TodoItem["status"],
    error: row.error,
    attachments: parseAttachments(row.attachments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TodoRepo {
  private db: DatabaseSyncInstance | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly databasePath?: string) {}

  close(): void {
    this.db?.close();
    this.db = null;
    this.ready = null;
  }

  private async ensure(): Promise<DatabaseSyncInstance> {
    this.ready ??= this.open();
    await this.ready;
    if (!this.db) throw new Error("todo db closed");
    return this.db;
  }

  private async open(): Promise<void> {
    const path = this.databasePath ?? getTasksIndexDatabasePath();
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    runTasksDatabaseMigrations(db);
    db.exec(TODO_SCHEMA);
    const columns = db.prepare("PRAGMA table_info(todos)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "attachments")) {
      db.exec("ALTER TABLE todos ADD COLUMN attachments TEXT");
    }
    this.db = db;
  }

  async create(params: TodoCreateParams): Promise<TodoItem> {
    const workspacePath = params.workspacePath.trim();
    const title = params.title.trim();
    const prompt = params.prompt.trim();
    const attachments = (params.attachments ?? []).filter(
      (file) => file.fileName && (file.localPath || file.dataBase64),
    );
    if (!workspacePath || !title || (!prompt && attachments.length === 0)) {
      throw new TodoStateError("标题、说明和项目都必填");
    }
    const db = await this.ensure();
    const now = Date.now();
    const workspaceKey = workspaceKeyOf({
      workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    db.exec("BEGIN IMMEDIATE");
    let id: string;
    try {
      id = allocateTodoId(db);
      db.prepare(
        `INSERT INTO todos (
          id, title, prompt, workspace_key, workspace_path, workspace_identity, attachments, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(
        id,
        title,
        prompt || "见附件。",
        workspaceKey,
        workspacePath,
        params.workspaceIdentity?.trim() || null,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        now,
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return (await this.get(id))!;
  }

  async list(workspaceKey?: string): Promise<TodoItem[]> {
    const db = await this.ensure();
    const rows = workspaceKey
      ? db
          .prepare(
            "SELECT * FROM todos WHERE workspace_key = ? ORDER BY updated_at DESC",
          )
          .all(workspaceKey)
      : db.prepare("SELECT * FROM todos ORDER BY updated_at DESC").all();
    return (rows as unknown as TodoRow[]).map(toItem);
  }

  async get(id: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    const row = db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as TodoRow | undefined;
    return row ? toItem(row) : null;
  }

  async getBySession(sessionId: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    const row = db
      .prepare("SELECT * FROM todos WHERE session_id = ?")
      .get(sessionId) as TodoRow | undefined;
    return row ? toItem(row) : null;
  }

  /** 只有 todo / failed 能占成 running。同一行并发开始只有一次成功。 */
  async claim(id: string): Promise<TodoItem | "missing" | "bad-status"> {
    const db = await this.ensure();
    const current = await this.get(id);
    if (!current) return "missing";
    if (current.status !== "todo" && current.status !== "failed") return "bad-status";
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE todos SET status = 'running', error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('todo', 'failed')`,
      )
      .run(now, id);
    if (result.changes === 1) return (await this.get(id))!;
    return "bad-status";
  }

  async attachRun(
    id: string,
    fields: {
      baseBranch: string;
      baseCommit: string;
      branchName: string;
      worktreePath: string;
      sessionId: string;
    },
  ): Promise<TodoItem> {
    const db = await this.ensure();
    db.prepare(
      `UPDATE todos SET base_branch = ?, base_commit = ?, branch_name = ?, worktree_path = ?,
       session_id = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    ).run(
      fields.baseBranch,
      fields.baseCommit,
      fields.branchName,
      fields.worktreePath,
      fields.sessionId,
      Date.now(),
      id,
    );
    return (await this.get(id))!;
  }

  async markFailed(id: string, error: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    db.prepare(
      `UPDATE todos SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(error, Date.now(), id);
    return this.get(id);
  }

  async settle(
    sessionId: string,
    outcome: "completed" | "failed",
  ): Promise<TodoItem | null> {
    const db = await this.ensure();
    const next = outcome === "failed" ? "failed" : "needs_review";
    const error = outcome === "failed" ? "会话失败" : null;
    db.prepare(
      `UPDATE todos SET status = ?, error = ?, updated_at = ?
       WHERE session_id = ? AND status = 'running'`,
    ).run(next, error, Date.now(), sessionId);
    return this.getBySession(sessionId);
  }

  async markDone(id: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    const result = db
      .prepare(
        `UPDATE todos SET status = 'done', error = NULL, updated_at = ?
         WHERE id = ? AND status = 'needs_review'`,
      )
      .run(Date.now(), id);
    if (result.changes !== 1) throw new TodoStateError("只有待审可以完成");
    return this.get(id);
  }

  async setError(id: string, error: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    db.prepare("UPDATE todos SET error = ?, updated_at = ? WHERE id = ?").run(
      error,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  async abandon(id: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    const result = db
      .prepare(
        `UPDATE todos SET status = 'canceled', updated_at = ?
         WHERE id = ? AND status != 'done'`,
      )
      .run(Date.now(), id);
    if (result.changes !== 1) throw new TodoStateError("已完成的 To-Do 不能放弃");
    return this.get(id);
  }

  async restore(id: string): Promise<TodoItem | null> {
    const db = await this.ensure();
    const result = db
      .prepare(
        `UPDATE todos SET status = 'todo', error = NULL, updated_at = ?
         WHERE id = ? AND status = 'canceled'`,
      )
      .run(Date.now(), id);
    if (result.changes !== 1) throw new TodoStateError("只有已放弃的 To-Do 可以恢复");
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const db = await this.ensure();
    db.prepare("DELETE FROM todos WHERE id = ?").run(id);
  }

  async failInterrupted(): Promise<number> {
    const db = await this.ensure();
    const result = db
      .prepare(
        `UPDATE todos SET status = 'failed', error = '中断', updated_at = ? WHERE status = 'running'`,
      )
      .run(Date.now());
    return Number(result.changes);
  }
}
