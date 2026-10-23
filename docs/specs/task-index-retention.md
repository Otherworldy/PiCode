# tasks-index 的删除 tombstone 保留期

## 背景

`tasks` 表的「删除会话」只写 `deleted = 1`：

```ts
// taskIndexRepo.ts 的 updateTaskState 系列
deleted = excluded.deleted      // 1
```

改造前**全仓不存在一条 `DELETE FROM tasks`**（`grep -rn "DELETE FROM tasks" packages/services/src/` 零命中），
也没有 `VACUUM` 或 `auto_vacuum`。后果是：

- 被删会话的行连同 `searchable_text`（`TASK_SEARCH_TEXT_MAX_CHARS = 200_000`，行内存储）
  永久驻留；
- 这些行继续被列表查询的全表扫描读到（见 `docs/specs/task-index-query-budget.md` 的三处读放大）；
- 库文件单调增长，没有任何回收路径。

`automationRepo.pruneRuns` 是同类问题的另一份实现 —— 它**存在但从未被调用**（全仓只有定义和
dist 的 `.d.ts`），本 spec 不覆盖它（见「未覆盖」）。

## 状态所有者

| 状态 | 所有者 |
| --- | --- |
| 哪些 tombstone 可以被删 | `TaskIndexRepo.pruneDeletedTasks({ olderThanMs })` |
| 保留期与清理频率 | `zcodeTaskServiceAdapter` 的 `DELETED_TASK_RETENTION_MS` / `DELETED_TASK_PRUNE_INTERVAL_MS` |
| 触发时机 | grouped 视图入口的 `runWorkspaceTaskAutoArchive` |

## 规则

1. **物理删除必须按 `updated_at` 判定年龄，不能按「删除时刻」。** 表里没有删除时间列，
   `updated_at` 是唯一可用的保守代理：它只会比真实删除时刻更早，因此不会误删近期删除的
   tombstone 供 undo 使用。
2. **不能删仍被分组引用的行。** `queryGroupedTaskView` 遇到「task_group_members 指向不可见
   task」会直接抛错，所以 `DELETE` 必须带
   `NOT EXISTS (SELECT 1 FROM task_group_members ...)` 子查询。被分组引用的 tombstone 保留，
   等用户自己解除分组。
3. **清理与自动归档解耦。** `runWorkspaceTaskAutoArchive` 在读设置失败或未启用时提前 return，
   但 tombstone 清理不该受这个开关影响 —— `maybePruneDeletedTasks()` 放在任何 return 之前。
4. **清理是 fire-and-forget，且失败不能影响列表读。** 它是全表条件删除，跟侧栏刷新同频是浪费，
   所以进程内按 24h 节流；失败只 `logger.warn` 并把节流戳复位（下一轮重试）。
5. **不做 `VACUUM`。** SQLite 删除后会复用空闲页，库文件不再单调增长即可满足目标；
   `VACUUM` 需要独占锁且耗时与库大小成正比，会阻塞 Host 的其它连接。要回收磁盘空间需要
   `auto_vacuum = INCREMENTAL`（只能在建库时设定或整库重建），属另一项改动。

## 接口

```ts
// TaskIndexRepo
/** @returns 实际删除的行数 */
async pruneDeletedTasks(params: { olderThanMs: number }): Promise<number>;
```

`DELETE` 语句：

```sql
DELETE FROM tasks
WHERE deleted = 1
  AND updated_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM task_group_members m
    WHERE m.workspace_key = tasks.workspace_key AND m.task_id = tasks.task_id
  )
```

整条语句在 `BEGIN IMMEDIATE` / `COMMIT` 内，失败 `ROLLBACK`。

## 验收场景

- 造一条 `deleted = 1`、`updated_at` 早于保留期的行：`pruneDeletedTasks` 返回 1，该行的
  `searchable_text` 不再被搜索命中。
- 同一条行如果同时是某个 `task_group_members` 的成员：**不被删除**，且
  `queryGroupedTaskView` 仍然正常返回（不抛「包含不可见 task」）。
- `deleted = 0` 的行无论如何都不被删。
- 未到保留期的 tombstone 不被删（undo / 分支图谱仍能读到它）。
- 连续两次 `pruneDeletedTasks`：第二次返回 0（幂等）。
- 清理失败（例如库被锁）不抛出到列表读路径，只留 warn 日志。

## 未覆盖（记录为后续项）

- **`automationRepo.pruneRuns` 仍然零调用**，`automation_runs` 行无上限（单个 automation
  每 5 分钟一次 = 288 行/天、10.5 万行/年），`listRuns` 也无 `LIMIT` 与分页。它有自己的
  retention 实现但没接线，需要单独决定保留期与触发点。
- **磁盘空间不回收**：规则 5 的取舍。库文件不会继续变大，但也不会变小。
- **`task_group_view_node_orders` 的孤儿行**：只排除了 `task_group_members`，没处理 order 表
  里指向已删 task 的 `node_key`。当前不会报错（`normalizeGroupedTopNodeOrders` 只处理缺失
  节点），但会成为新一类垃圾数据。
- **清理是进程内的**：如果用户长期不开侧栏，`runWorkspaceTaskAutoArchive` 不会被调用，
  清理也就不发生。要做成可靠的后台任务需要接到 scheduler。
