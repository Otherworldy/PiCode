# tasks-index 查询预算：列表读、索引命中与正文摘要

## 背景

`packages/services/src/session/taskIndexRepo.ts` 是侧栏任务列表的唯一数据源。它的 `tasks` 表把
**聊天正文**整段存在行内（`searchable_text TEXT NOT NULL DEFAULT ''`，上限
`TASK_SEARCH_TEXT_MAX_CHARS = 200_000`），而这张表同时服务三类查询：

1. 列表/成员集刷新（高频，每次侧栏可见性变化都跑）
2. 单行读改写（每个 turn 结束的 patch）
3. 全文搜索（用户敲键时）

改造前这三类查询都按同一个形状写，导致正文在**完全用不到它的路径上被反复搬运**。三处实测
（400 行 × 200k 字符，本机 `node:sqlite` 同形 SQL）：

| 形态 | 耗时 | 堆增量 |
| --- | --- | --- |
| 列表查询读全 22 列（含正文） | 288 ms / 次 | +7.35 MB |
| 列表查询只取 `task_id, meta_json` | 0.5 ms / 次 | +0.015 MB |
| 搜索：`LOWER(...) LIKE` + 返回完整正文 | 32 ms / 次 | +11.6 MB |
| 搜索：去 `LOWER` + SQL 侧截取摘要 | **2.7 ms / 次** | +0.02 MB |

### 三个独立成因

**成因 1：列表路径把正文读出来丢掉。**
`listTaskMetas` 的 SELECT 含 `searchable_text`，而唯一消费列的函数 `rowToMeta` 只读
`meta_json` 和几个标量列 —— 正文读进来立刻被 GC。放大倍数来自调用方
（`packages/ui/src/lib/taskListMembershipSets.ts`）：一次侧栏刷新 = `listPinnedTaskIds()`
（全局）+ 每个 scope 的 `listArchivedTasks` / `listTasks` / `listPinnedTasks` /
`listDeletedTaskIds`，即 **1 + 4×scopes** 次全列读。

**成因 2：参数化 OR 谓词让 workspace 索引完全失效。**

```sql
WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
```

`EXPLAIN QUERY PLAN` 实测：该形态 → `SCAN tasks`；直白等值 → `SEARCH tasks USING INDEX
idx_tasks_workspace_archived_updated (workspace_key=?)`。`listPinnedTaskIds()` 更进一步 ——
它**不传** `workspacePath`，于是扫全库所有 workspace 的 pinned 行，只为拿一个 `taskId` 数组。

**成因 3：搜索把正文整段搬进 JS。**

```sql
WHERE (LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)
```

两处浪费：`LOWER()` 对每一扫描行（400 行）复制一份 200k 字符的临时字符串；结果集又把完整
正文（50 行 × 200k = 10 MB）跨 SQLite→JS 边界搬一次。实测拆解：

| 变体 | 耗时/轮 | 说明 |
| --- | --- | --- |
| 生产形态 | 32 ms | `LOWER` + 读完整正文 |
| 去掉 `LOWER`，仍读完整正文 | 30 ms | 只省 7% —— **瓶颈不是 `LOWER`** |
| 去掉 `LOWER`，不读正文 | 1.1 ms | 快 27 倍 —— **瓶颈是正文跨边界** |
| 去掉 `LOWER` + SQL 侧截取摘要 | **2.7 ms** | 保留摘要能力，仍是 12 倍 |

关键结论：**优化点是"别把正文搬出来"，不是"别调 `LOWER`"**。

### 为什么不用 FTS5

已验证 `node:sqlite`（SQLite 3.51.3）编译了 FTS5，但两个方案都不成立：

- `tokenize='unicode61'`：连续中文被当成一个 token，搜「测试」命中 0。
- `tokenize='trigram'`：要求查询词 **≥3 字符**。实测「字符串」（3 字）命中 1，「中文」「测试」
  （2 字）命中 0 —— 而 2 字词是中文搜索的常态。

按字切分再建 FTS 的方案可行但索引体积翻倍、需处理标点与大小写、还要 migration + triggers
同步，本 spec 不做（见「未覆盖」）。

## 状态所有者

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| `tasks` 表（含 `searchable_text` 列） | `taskIndexRepo` | 列的**声明**由 `tasksDatabase/migrations.ts` 的冻结 `columns` 数组持有，不得改动（checksum 会破） |
| 列表查询的列集合 | `TaskIndexRow` 类型 + 各 SELECT | 唯一允许出现 `searchable_text` 的地方是搜索路径的摘要表达式 |
| 搜索摘要窗口 | SQL 侧 `substr`/`instr` | JS 只做空白折叠与截断 |
| 正文写入时机 | `writeRecord` | 只在 `record.searchableText !== undefined` 时单独 UPDATE |

## 规则

1. **`TaskIndexRow` 不含 `searchable_text`。** 它是列表行/元数据行的形状，不是正文行的形状。
   需要正文的只有搜索路径，且它以 `search_snippet` 别名返回**已截断的窗口**，不是整列。
2. **列表查询的列集合必须是"消费方真正读的列"。** 新增 SELECT 时先确认返回结构体里哪个字段
   被读；`rowToMeta` 不读的列一律不进 SELECT。
3. **参数化 OR 不得用于可选过滤条件。** 可选谓词按存在性**拼 SQL 串**（值仍用 `@name` 绑定），
   让 SQLite 看到的是 `workspace_key = @workspace_key` 而不是 `(@x IS NULL OR col = @x)`。
   例外：`workspace_key IN (...)` 形态本身不破坏索引，保持。
4. **搜索谓词不用 `LOWER()`。** SQLite 的 `case_sensitive_like` 默认 off，`col LIKE '%x%'` 对
   ASCII 已经大小写不敏感（实测 `'ABC' LIKE '%abc%'` = 1），与 `LOWER(col) LIKE ?` 等价。
   全仓未设置该 pragma，依赖此默认值。
5. **正文只在 SQL 侧截取，不跨边界搬运。** 搜索的 SELECT 用
   `substr(searchable_text, max(1, instr(lower(searchable_text), ?) - <prefix>), <window>)`
   返回窗口，另附 `instr(...)` 位置与 `length(...)` 总长，让 JS 判断是否需要 `...` 前后缀。
   `lower()` 在这里只对**返回行**（≤ limit）求值，不是对全部扫描行。
6. **`writeRecord` 不重写正文列。** 主 `INSERT ... ON CONFLICT DO UPDATE` 的列集合不含
   `searchable_text`（走 `DEFAULT ''`），正文变化时单独 `UPDATE tasks SET searchable_text = ?`。
   这样每个 turn 的标题/状态 patch 不再落 ~600 KB WAL。
7. **那两条语句必须同事务。** 拆成两条独立语句后，若 INSERT 已提交而正文 UPDATE 失败
   （崩溃、库锁超时），会留下 `searchable_text = ''` 的行 —— 该会话正文从此搜不到，要等下一次
   snapshot 同步重算才自愈。`writeRecord` 用 `const ownsTransaction = !database.isTransaction`
   判断：调用方可能已在事务内（`syncTaskMetaAtGroupedTop` 的 `BEGIN IMMEDIATE`，SQLite 不支持
   嵌套事务），所以只在没有事务时自己 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。
8. **摘要片段数从 4 降到 1。** 原 `buildSearchSnippets` 会为同一正文产出最多 4 个去重片段；
   SQL 侧只截取首个匹配窗口。这是**有意的行为变更**：搜索结果展示一行上下文，代价换 12 倍
   速度。`TASK_SEARCH_SNIPPET_LIMIT` / `_PREFIX_RADIUS` / `_SUFFIX_RADIUS` 保留给窗口尺寸。
9. **大小写不敏感的位置必须与谓词一致。** 谓词用 `LIKE`（不敏感），位置用
   `instr(lower(...), lower(?))`（不敏感）—— 两侧都按不敏感算，否则用户搜小写命中大写正文时
   摘要窗口会取错位置。
10. **摘要参数必须排在 WHERE 参数之前。** SQLite 按 `?` 在 SQL 文本里的出现顺序取值，而
    `snippetSelect` 位于 SELECT 子句（在 WHERE 之前）。增删带 `?` 的表达式时务必同步核对
    `.all(...)` 实参顺序 —— 错位不会报错，只会静默返回错摘要或错行。
11. **本条规则同样适用于其它可选过滤。** `listDeletedTaskIds` 的
    `(@provider IS NULL OR provider = @provider)` 一并改成按存在性拼串。

## 接口

```ts
// 列表行：不含正文
interface TaskIndexRow {
  workspace_key: string;
  // ...其余 20 列...
  meta_json: string;
}

// 搜索行：在 TaskIndexRow 基础上加三个摘要字段
interface TaskIndexSearchRow extends TaskIndexRow {
  search_snippet: string | null;   // 已截断窗口；正文为空时为 null
  search_pos: number;              // 1-based 首次匹配位置；0 = 未命中（title 命中场景）
  search_len: number;              // 正文总长，用于判断后缀 "..."
}

// 摘要构造：输入是 SQL 已截取的窗口
function buildSearchSnippetsFromRow(row: TaskIndexSearchRow, search: string | null): string[];
```

`listTaskMetas` 的谓词拼装（示意）：

```ts
const where: string[] = [];
const args: Record<string, unknown> = {};
if (targetWorkspaceKey !== null) {
  where.push("workspace_key = @workspace_key");
  args.workspace_key = targetWorkspaceKey;
}
if (!includeDeleted) where.push("deleted = 0");
if (params.provider !== undefined) { where.push("provider = @provider"); args.provider = params.provider; }
// pinned / archived / deleted 同形
```

## 验收场景

- 侧栏刷新（1 + 4×scopes 次 `listTaskMetas`）不再读取 `searchable_text`：用 `EXPLAIN QUERY PLAN`
  断言列表查询走 `SEARCH ... USING INDEX`，且 400 行 × 200k 字符场景下单次 < 5 ms。
- `listPinnedTaskIds()` 在传 workspace 时只扫该 workspace；不传时允许全库扫，但**只读
  `task_id`**，不读正文。
- 搜索仍能命中正文：正文含「测试」时搜「测试」返回该行；正文含 `Hello` 时搜 `hello` 返回该行
  且摘要窗口**包含 Hello 附近内容**（验证规则 8）。
- 搜索摘要：命中位置靠近开头时无 `...` 前缀；靠近结尾时无 `...` 后缀；`title` 命中而正文未命中
  时回退为正文开头窗口。
- 标题 patch 不再写正文：同一 task 连续 10 次 `updateTaskState`（标题/状态变更）后，
  `searchable_text` 逐字节不变，且 WAL 增量与正文长度无关。
- 正文同步仍生效：`syncTaskMeta({ searchableText })` 后搜索能立即命中新内容。
- 搜索结果 `total` 与改造前一致（COUNT 逻辑不变）。

## 未覆盖（记录为后续项）

- **`searchable_text` 列仍在 `tasks` 表内。** 迁移账本
  （`tasksDatabase/migrations.ts` 的 `columns` 数组）已冻结，改它会破坏 `0001` 的 checksum，
  所以不能删列。当前做法是「不读、不重写」，旧行里的 200k 字符正文仍占空间，要回收需要新增
  migration + `VACUUM`。
- **搜索仍是全表扫。** 谓词 `searchable_text LIKE '%x%'` 无法用任何索引，本 spec 只消除了
  「搬运」而非「扫描」。要消除扫描需按字切分建 FTS 表（索引体积翻倍 + migration + triggers）。
- **COUNT 与 SELECT 双扫未合并。** 实测 COUNT 单扫 0.8 ms/轮，占比小；合并（`LIMIT n+1` 探测）
  会让 `total`/`hasMore` 逻辑复杂化，收益不匹配。
- **`archiveStaleTasks` 的归档谓词**与 `listTaskMetas` 共用 `where` 拼装风格，本次一并去掉正文
  列，但其自身的索引形态（`archived = 0 AND updated_at < ?`）未单独验证。
- **`tasks` 表无 retention、无 `VACUUM`**（第五轮 P0-8），删除只写 tombstone。
- **同类参数化 OR 形态的其他文件**：`offPeakTaskRepo.ts:332,335`、`automationRepo.ts:303,403,1370`
  本轮未改（各自表结构与索引不同，需单独验证）。
- **`LIKE` 的通配符与 `instr` 的字面量口径不一致。** 搜 `100%` 时谓词命中（`%` 是通配符），
  而 `instr(lower(text), '100%')` 找字面量返回 0 → 摘要窗口退化为正文开头。旧实现同样有
  LIKE 通配符问题，但旧兜底是整段正文、新兜底是开头窗口，退化更明显。修法是在拼 pattern 时
  转义 `%`/`_` 并配 `ESCAPE`，属于既有一致性问题，单独立项。
- **`lower(searchable_text)` 每个返回行仍求值两次**（`substr` 里的和 `instr` 里的是两个独立
  表达式，SQLite 不做跨表达式公共子表达式消除）。只对返回行（≤ limit）求值，不进 JS 堆；
  实测 50 行 / 10 轮 = 27 ms 已包含这份成本。要消除得用 CTE 先算 `lower()`，但内层子查询会
  对**全部扫描行**求值，反而更慢。
- **`TaskIndexRow` 仍声明了 4 条路径不返回的列**（`last_unread_at`）。当前唯一的读取点是
  `getTaskRow` 的调用方，而 `getTaskRow` 确实返回该列，所以无害；但所有 SELECT 都是
  `as unknown as` 强转，将来在 `rowToMeta` 里读它会在那 4 条路径静默变 `undefined`。
- **`search_len`（SQLite 码点数）与 `window.length`（UTF-16 长度）混用**：代理对（emoji）
  会让后缀 `"..."` 的判断偏一个字符，只影响省略号是否多显示，窗口内容不会取错。
