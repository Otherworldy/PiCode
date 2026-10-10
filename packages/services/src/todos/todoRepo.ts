import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  normalizeTodoTags,
  type TodoCreateParams,
  type TodoItem,
  type TodoUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { storedAttachments, usableAttachments } from "#src/todos/todoAttachments.js";
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
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_workspace ON todos(workspace_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id) WHERE session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS todo_seq (n INTEGER NOT NULL);
-- ponytail: 用过的标签全局留着，删任务也不清。目录变大后再按项目拆。
CREATE TABLE IF NOT EXISTS todo_tag_catalog (name TEXT PRIMARY KEY COLLATE NOCASE);
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
  tags: string | null;
  created_at: number;
  updated_at: number;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function tagsOf(input: readonly string[] | undefined): string[] {
  try {
    return normalizeTodoTags(input ?? []);
  } catch (error) {
    throw new TodoStateError(error instanceof Error ? error.message : String(error));
  }
}

function rememberTags(db: DatabaseSyncInstance, tags: string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO todo_tag_catalog (name) VALUES (?)");
  for (const name of tags) insert.run(name);
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
    attachments: storedAttachments(row.attachments),
    tags: parseTags(row.tags),
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
    if (!columns.some((column) => column.name === "tags")) {
      db.exec("ALTER TABLE todos ADD COLUMN tags TEXT");
    }
    this.db = db;
  }

  async create(params: TodoCreateParams): Promise<TodoItem> {
    const workspacePath = params.workspacePath.trim();
    const title = params.title.trim();
    const prompt = params.prompt.trim();
    const attachments = usableAttachments(params.attachments);
    const tags = tagsOf(params.tags);
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
          id, title, prompt, workspace_key, workspace_path, workspace_identity, attachments, tags, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(
        id,
        title,
        prompt || "见附件。",
        workspaceKey,
        workspacePath,
        params.workspaceIdentity?.trim() || null,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        tags.length > 0 ? JSON.stringify(tags) : null,
        now,
        now,
      );
      rememberTags(db, tags);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return (await this.get(id))!;
  }

  async update(id: string, params: TodoUpdateParams): Promise<TodoItem> {
    const current = await this.get(id);
    if (!current) throw new TodoStateError("To-Do 不存在");
    if (current.status !== "todo") throw new TodoStateError("只有未开始的 To-Do 可以修改");
    const title = params.title.trim();
    const prompt = params.prompt.trim();
    const submitted = params as TodoUpdateParams & { attachments?: TodoItem["attachments"] };
    const attachments =
      submitted.attachments === undefined
        ? current.attachments
        : usableAttachments(submitted.attachments);
    if (!title || (!prompt && attachments.length === 0)) {
      throw new TodoStateError("标题和说明都必填");
    }
    const db = await this.ensure();
    const result = db
      .prepare(
        `UPDATE todos SET title = ?, prompt = ?, attachments = ?, updated_at = ?
         WHERE id = ? AND status = 'todo'`,
      )
      .run(
        title,
        prompt || "见附件。",
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        Date.now(),
        id,
      );
    if (result.changes !== 1) throw new TodoStateError("只有未开始的 To-Do 可以修改");
    return (await this.get(id))!;
  }

  async setTags(id: string, tags: string[]): Promise<TodoItem> {
    const normalized = tagsOf(tags);
    const current = await this.get(id);
    if (!current) throw new TodoStateError("To-Do 不存在");
    const db = await this.ensure();
    db.prepare("UPDATE todos SET tags = ?, updated_at = ? WHERE id = ?").run(
      normalized.length > 0 ? JSON.stringify(normalized) : null,
      Date.now(),
      id,
    );
    rememberTags(db, normalized);
    return (await this.get(id))!;
  }

  async listTags(): Promise<string[]> {
    const db = await this.ensure();
    const rows = db
      .prepare("SELECT name FROM todo_tag_catalog ORDER BY name COLLATE NOCASE")
      .all() as {
      name: string;
    }[];
    return rows.map((row) => row.name);
  }

  async list(workspaceKey?: string): Promise<TodoItem[]> {
    const db = await this.ensure();
    const rows = workspaceKey
      ? db
          .prepare("SELECT * FROM todos WHERE workspace_key = ? ORDER BY updated_at DESC")
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
    const row = db.prepare("SELECT * FROM todos WHERE session_id = ?").get(sessionId) as
      | TodoRow
      | undefined;
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

  /** 还在跑则拉回进行中；已结束则进行中或失败进待审。待审上的合并错误保留。 */
  async noteSessionActivity(sessionId: string, running: boolean): Promise<TodoItem | null> {
    const current = await this.getBySession(sessionId);
    if (!current) return null;
    const matches = running
      ? current.status === "needs_review" || current.status === "failed"
      : current.status === "running" || current.status === "failed";
    if (!matches) return current;
    const db = await this.ensure();
    const from = running ? "('needs_review', 'failed')" : "('running', 'failed')";
    db.prepare(
      `UPDATE todos SET status = ?, error = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND status IN ${from}`,
    ).run(running ? "running" : "needs_review", Date.now(), current.id, sessionId);
    return this.get(current.id);
  }

  async settle(sessionId: string, _outcome: "completed" | "failed"): Promise<TodoItem | null> {
    return this.noteSessionActivity(sessionId, false);
  }

  /** 会话没了。进行中改失败；待审只记一笔。工作树不动。 */
  async noteSessionRemoved(sessionId: string): Promise<TodoItem | null> {
    const current = await this.getBySession(sessionId);
    if (!current) return null;
    const db = await this.ensure();
    const now = Date.now();
    if (current.status === "running") {
      db.prepare(
        `UPDATE todos SET status = 'failed', error = '会话已删除', session_id = NULL, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'running'`,
      ).run(now, current.id, sessionId);
    } else if (current.status === "needs_review") {
      db.prepare(
        `UPDATE todos SET error = '会话已删除', session_id = NULL, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'needs_review'`,
      ).run(now, current.id, sessionId);
    } else {
      db.prepare(
        `UPDATE todos SET session_id = NULL, updated_at = ? WHERE id = ? AND session_id = ?`,
      ).run(now, current.id, sessionId);
    }
    return this.get(current.id);
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
}
