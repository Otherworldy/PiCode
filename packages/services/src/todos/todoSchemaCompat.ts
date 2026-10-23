import type { DatabaseSync } from "node:sqlite";

type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/**
 * 把已存在的 todos 表补齐到当前代码需要的列，并兼容旧发行版的列名。
 *
 * 为什么必须显式做：
 * 1. `CREATE TABLE IF NOT EXISTS`（`TODO_SCHEMA`）对已存在的表不做任何改动。
 * 2. 旧库里 `idx_todos_session` 指向 `last_session_id`，而 `CREATE INDEX IF NOT EXISTS`
 *    只比较索引名 → 整条语句被静默跳过，`exec` 返回成功但表缺列。
 * 3. 于是运行期第一条 `SELECT * FROM todos WHERE session_id = ?` 抛 `no such column`，
 *    经后台 fire-and-forget 的对齐路径变成 unhandled rejection，直接终止 Host。
 *
 * 只做加法：不删旧列、不删旧索引 —— 写这个库的其他版本可能还在用它们。
 */
export function ensureTodoSchemaColumns(db: DatabaseSyncInstance): void {
  const columns = (db.prepare("PRAGMA table_info(todos)").all() as { name: string }[]).map(
    (column) => column.name,
  );

  const addColumnIfMissing = (column: string, legacyColumn?: string) => {
    if (columns.includes(column)) return;
    db.exec(`ALTER TABLE todos ADD COLUMN ${column} TEXT`);
    // 只加空列不够：旧值必须跟过来，否则旧 todo 在界面上「存在但对不上会话」。
    if (legacyColumn && columns.includes(legacyColumn)) {
      db.exec(`UPDATE todos SET ${column} = ${legacyColumn} WHERE ${column} IS NULL`);
    }
    columns.push(column);
  };

  addColumnIfMissing("session_id", "last_session_id");
  addColumnIfMissing("base_branch", "base_ref");
  addColumnIfMissing("attachments");
  addColumnIfMissing("tags");
  // 为当前列单独建一个不同名的索引；旧的同名索引继续指向旧列。
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id) WHERE session_id IS NOT NULL",
  );
}
