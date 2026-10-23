# todos 表 schema 漂移与后台对齐隔离

## 背景

`~/.PiCode/v2/tasks-index.sqlite` 里存在**旧发行版**写出的 `todos` 表：列名是
`last_session_id` / `base_ref` / `merged_at` / `unread_at`，而当前代码的 `TODO_SCHEMA`
期望 `session_id` / `base_branch`。

`TodoRepo.open()` 的执行顺序（`packages/services/src/todos/todoRepo.ts:149-163`）：

1. `db.exec(TODO_SCHEMA)` —— `CREATE TABLE IF NOT EXISTS` 对已存在的表**不做任何改动**；
   `CREATE INDEX IF NOT EXISTS idx_todos_session` 只认索引名，旧库里这个索引已经存在
   （指向 `last_session_id`），于是整条语句被静默跳过。**结果：`exec` 返回成功，但表缺列。**
2. 补列迁移只覆盖 `attachments` / `tags`，漏了 `session_id` / `base_branch`。
3. 运行期第一条 `SELECT * FROM todos WHERE session_id = ?`
   （`todoRepo.ts:282`，经 `noteSessionActivity`）抛 `no such column: session_id`。
4. 唯一的生产调用点是 `packages/services/src/node.ts:2777` 的
   `void todoService.alignSessions(sessions)` —— **没有 catch**。未捕获的 rejection
   在 Node 24 下直接终止进程。

本地实测（真实库副本，0 行数据）：

```
TODO_SCHEMA exec: OK (静默跳过，旧索引同名)
SELECT session_id THREW: no such column: session_id
has session_id: false | has base_branch: false
```

实际后果：server 启动约 20 秒后 `exit 1`，前端显示「Web 启动失败 / WebSocket connection failed」。
这不是数据损坏，而是**整个 Host 因一次后台 todo 对齐而退出**。

## 状态所有者

| 职责 | 所有者 |
| --- | --- |
| todos 表结构兼容（补列、回填、索引） | `TodoRepo.open()`（唯一打开点） |
| 后台对齐的异常边界 | `node.ts` 的 `alignTodos` 封装 |

## 规则

1. **`CREATE TABLE IF NOT EXISTS` 不能作为 schema 迁移手段。** 表已存在时它什么都不做；
   任何当前代码会读到的列，都必须在 `open()` 里显式验证并按需 `ALTER TABLE` 补齐。
2. **补列时必须兼容旧列名并回填**，而不是只加一个空列：
   `session_id ← last_session_id`、`base_branch ← base_ref`。只加空列会让旧数据「看起来
   存在但对不上」，比崩溃更难排查。
3. **索引不能只靠 `CREATE INDEX IF NOT EXISTS`。** 同名索引可能指向旧列，`IF NOT EXISTS`
   只比较名字。为当前列新建**不同名**的索引（`idx_todos_session_id`），不要删旧索引 ——
   写这个库的其他版本可能还在用它。
4. **后台 fire-and-forget 的 todo 对齐必须自带 catch。** `alignSessions` 是跨 workspace
   的后台维护路径，它失败不应该影响 Host 存活；否则任何 schema 漂移、磁盘满、库被外部
   独占都会表现为「应用莫名其妙退出」。
5. **不删除旧列和旧索引。** 版本回退与新版本共存都依赖它们；本 spec 只做加法。

## 接口

```ts
// todoRepo.ts —— 行为变化只在 open() 内部，签名不变
class TodoRepo {
  constructor(databasePath?: string);
  // open() 现在保证：返回后 session_id / base_branch / attachments / tags 均存在，
  // 且存在一个指向 session_id 的索引。
}

// node.ts
alignTodos = (sessions: readonly TodoSessionFact[]) => void; // 内部吞掉失败并 warn
```

## 验收场景

1. **旧 schema 库可打开**：用 `last_session_id` / `base_ref` 建表并插入一行，
   `new TodoRepo(path)` 后调用 `getBySession(id)` 返回该行，`baseBranch` 已回填。
2. **回填不覆盖已有值**：同时有 `session_id` 与 `last_session_id` 且值不同时，保留
   `session_id`。
3. **新库不受影响**：全新路径下 `TODO_SCHEMA` 建表，四个列都在，`idx_todos_session_id` 存在。
4. **重复打开幂等**：同一路径打开两次不报错、不重复加列。
5. **对齐失败不杀进程**：`alignSessions` 抛错时 `alignTodos` 返回，进程继续存活
   （日志一条 warn）。
6. **真实旧库回归**：把 `~/.PiCode/v2/tasks-index.sqlite` 的副本交给 `TodoRepo` 打开，
   `SELECT * FROM todos WHERE session_id = ?` 不再抛错。

## 未覆盖

- **不校验未知列**：旧库多出来的 `merged_at` / `unread_at` 保持原样，代码不读也不写；
  哪天要用得上必须单独迁移（`unread_at` 已在 `tasks` 表里被大量使用，不要混淆）。
- **不做 `VACUUM` / 不收缩文件**：补列会让行变宽，但表只有几十行，收益不足。
- **不覆盖 `alignSessions` 之外的未捕获路径**：`noteTodoSessionRemoved`、
  `todoService.create` 等仍由各自的调用方负责 catch；本 spec 只堵住会杀死 Host 的那条。
- **不解决多版本并发写**：两个 PiCode 版本同时打开同一个 `tasks-index.sqlite` 时仍可能
  互相覆盖；这属于产品级的「单实例」约束，不在本次范围。
