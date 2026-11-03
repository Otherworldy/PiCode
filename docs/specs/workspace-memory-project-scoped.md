# 工作区记忆：项目内存储、项目级开关与 Pi 主路径接入

## 背景

改造前 Project Memory 有两套事实：写入/注入/抽取在旧 `AgentRuntime`
（`apps/zcode-cli/packages/core`），存储根为 `<dataRoot>/cli/memories/projects/<slug>-<hash>/memory`；
V4 Desktop 主路径已切到 Pi Host，既不读 `MEMORY.md` 也不在 turn 结束后抽取。
旧栈的抽取链（`memory/extraction.ts`、`memory-agent-loop.ts`、`memory/recall/`、
`runtime/helpers/project-memory*`）、旧注入段（`context/sections/memory.ts`）、旧索引格式化器
（`memory/index-content.ts`）与子代理持久记忆（`subagent/persistent-memory*`）已整条删除，
现在只有一套实现。`memory/project-root.ts` 保留，只服务旧全局目录的惰性迁移。

## 目标

1. 记忆文件存到 `<workspacePath>/.pi/memory/`，跟随项目，不再集中到 app 数据目录。
2. 开关改为项目配置 `<workspacePath>/.pi/picode.json` 的 `features.memory`，缺省关闭。
3. Pi 主路径：每个 turn 注入 `MEMORY.md`；turn 结束后台抽取并写入项目目录。
4. 记忆文件默认被本仓库忽略，不进入 `git status` / diff。
5. 旧全局记忆在首次打开项目时惰性迁移。
6. 远端工作区（`workspaceIdentity` 以 `remote:` 开头）禁用记忆并给出明确提示。

## 非目标

- 远端（SSH / WSL / Docker）记忆读写。
- 团队共享或提交记忆。
- 子代理 profile 的 `memory: user|project|local` 字段（frontmatter 契约与诊断码，
  随旧栈下线已无消费者，但删字段等于改用户配置格式）的清理。
- 协议层 `modelExecution.memoryExtraction` 字段：runtime 已不再读它（旧抽取调度器已删），
  但 `packages/shared` 的 zod `.strict()` 也用它校验历史持久化的 intent，
  删字段会让旧 payload 校验失败，因此保留为兼容字段。
- CLI 全局 `features.memory` / `memory.use` 配置键（`~/.PiCode/config.json`）：
  runtime 已不再读取，键本身保留为配置文件格式。项目级开关走 `.pi/picode.json`。

## 状态所有者

| 状态               | 所有者                                          | 说明                                         |
| ------------------ | ----------------------------------------------- | -------------------------------------------- |
| 记忆文件内容       | Pi Host session（写入）                         | `<workspace>/.pi/memory/*.md`                |
| 记忆读取 / 编辑 UI | `IMemoryService`                                | 读写记忆文件与项目开关                       |
| 项目开关           | `<workspace>/.pi/picode.json` `features.memory` | 唯一写入入口 `updateJsonConfigFile`          |
| 启用判定           | Pi extension 每轮读 `.pi/picode.json`           | 只有显式 `features.memory: true` 才开启      |
| 自动抽取调度       | `HostSessionRegistry`                           | 每个 session 同时最多一个 in-flight          |
| 抽取游标           | `HostSessionRegistry`                           | 上次抽取覆盖到的最后一个 turnId              |
| 索引与文件对账     | `reconcileWorkspaceMemoryIndex`（shared）       | 抽取落盘、直接写入归一与 UI 增删后各对账一次 |
| 直接写入归一       | 记忆扩展 `tool_result`（pi-host）               | 模型 Write/Edit 记忆文件后补字段与索引行     |
| 旧数据迁移         | `createPiSessionRecord`                         | 本地 workspace 首次创建时惰性复制            |

全局 app 设置 `memoryEnabled` 不再参与判定，设置页不再暴露；字段保留仅为兼容旧 `setting.json`。
旧版把这份配置写在项目根 `zcode.json`。读取 `.pi/picode.json` 不存在时会先把旧文件内容复制过去（旧文件保留），已有项目不需要手动改配置。

迁移是一次性的：`.pi/picode.json` 一旦存在，根目录 `zcode.json` 就不再被读取，继续编辑旧文件不会生效。workspace hooks 的自动发现也走同一条迁移路径，`configFileKind` 新增 `picode.json`；发现范围是工作区到 git 根之间的每一层，祖先目录的 `zcode.json` 同样会被复制成该目录的 `.pi/picode.json`，否则上游 hooks 会静默消失。

项目开关在每个 turn 重新读取，关闭后下一轮即停止注入与抽取，不必重开会话。

会话创建时只把开关值当初始快照；注入扩展按“能力位”注册，不按开关注册。
能力位 = 本地工作区且非侧聊/子会话，远端与侧聊不注册扩展。所以用户在正在进行的
会话里打开开关，下一轮就恢复注入与抽取，不需要新建会话。

## 存储布局

```text
<workspace>/.pi/memory/
  MEMORY.md          # 索引，始终注入；一行一条
  <name>.md          # 单条记忆，frontmatter + 正文
```

规则：

1. 文件名必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}\.md$`，且不能是 `MEMORY.md`；Windows 设备名
   （`con.md`、`aux.md`、`nul.md` 等）视为非法。
2. 记忆目录不存在时由宿主创建；目录和文件都不能是 symlink，根目录 `realpath` 必须等于自身。
3. 读取与写入前都重新校验根目录身份；仓库里提交的 `.pi/memory` symlink 直接让本会话关闭记忆。
4. 单文件读取上限沿用 5 MiB；抽取写入上限 64 KiB/文件、32 KiB 索引。
5. 索引缺失时 catalog 仍返回一行 `MEMORY.md`（`missing: true`），点击可创建；抽取写回 patch
   没带 `index` 时，若索引缺失或为空，按现有条目自动重建。

### Frontmatter 契约

每条记忆的 frontmatter 在原有 `name` / `description` 之外，新增 4 组轻量语义字段。
全部可缺省，旧文件不迁移、不改写：

```yaml
---
name: 必须用 Node 24            # 索引指针行的标题
description: mise 已固定，CI 也用 24   # 索引指针行的 hook
category: project               # project | todo | extension | ui | protocol
type: constraint                # preference | constraint | decision | fact
source: user                    # user | assistant | code
confirmed: true                 # 用户明确说过 / 只是模型推断
lastConfirmed: 2026-02-14       # 最近一次被确认的日期，参与过期判定
expires: 2026-06-01             # 可选：显式失效日期
---
```

| 字段 | 缺省 | 用途 |
| --- | --- | --- |
| `category` | `project` | 主题分类，为后续按类检索/分组预留；未知值按缺省处理，不报错 |
| `type` | `fact` | 语义类型：偏好、约束、决策、事实 |
| `source` | `assistant` | 来源：用户明说 / 模型推断 / 代码事实 |
| `confirmed` | `false` | 是否经用户确认；`false` 表示模型推断，出现冲突时优先牺牲它 |
| `lastConfirmed` | 文件 mtime | 最近确认日期，过期判定取它与 mtime 的较新值 |
| `expires` | 无 | 显式失效日期，优先于闲置天数 |

解析一律宽容：字段缺失、枚举值非法、日期格式不对都退回缺省，不让一条记忆因为
frontmatter 写歪而消失。索引指针行格式不变（`- [Title](file.md) — hook`），
`category` 只存 frontmatter，不占索引注入预算。

### 过期与清理

```text
过期判定（单文件）：
  if expires 存在且 <= 今天            → 过期
  else if max(lastConfirmed, mtime) <= 今天 - 90 天 → 过期
  else                                 → 保留

清理时机：
  会话创建时（preparePiWorkspaceMemory，开关为开）
  抽取落盘成功后（applyWorkspaceMemoryPatch 之后）
  两者都只在本地工作区、开关为开时执行
```

- 默认闲置阈值 `WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS = 90`；项目可在
  `.pi/picode.json` 用 `features.memoryExpiryDays` 覆盖，`0` 表示关闭自动清理。
- 阈值在项目记忆弹窗里可视化配置（`WorkspaceMemoryExpirySelect`，预设 7 / 30 / 90 / 180 / 365
  天 + 「不按闲置清理」）；写入只改 `features.memoryExpiryDays`，`null` 删除配置回到默认。
  配置里是预设外的值（例如手写 45）时补一项显示，避免选择器变成空值。
- 过期文件移动到 `.pi/memory/.expired/<name>.md`，不直接 `rm`：误判可恢复，
  且 `.expired` 是子目录，`readdir` 的 `isFile()` 过滤、注入、对账都看不到它，
  不会重新出现在索引或提示词里。
- 清理后调用一次 `reconcileWorkspaceMemoryIndex`，让索引里的指针行一起消失。
- 查看器打开列表时**不做**清理：UI 只是只读快照，不在用户没操作时删文件。
- 清理结果写 `info` 日志（`workspace memory pruned`，含文件数与原因分布）。

## 开关与优先级

```text
remote workspace           → 强制关闭
features.memory === true   → 开启
features.memory === false  → 关闭
memory.use === true        → 开启（CLI 兼容）
否则                       → 关闭
```

- 开关只写 `<workspace>/.pi/picode.json`，只改 `features.memory`，保留其它键。
- 全局 `memoryEnabled` 字段保留但忽略；旧值不迁移成项目开关，避免把“全局开”批量写进所有项目。
- 读写必须走 `updateJsonConfigFile`（文件锁 + 原子写），不新增裸 `writeFile`。
- 开关只有一个事实源，就是 `.pi/picode.json`：注入扩展、抽取调度、写记忆免确认各自
  在用到的那一刻 `readWorkspaceMemoryEnabled(workspacePath)`，不缓存成会话状态。
  会话创建时读到的值只用于建目录和迁移，不参与后续判定。
- Pi extension 与抽取调度在每个 turn 重新读开关；关闭后下一轮删除已注入的 section 并停止抽取。
- 开关只有一个事实源，就是 `.pi/picode.json`：注入扩展、抽取调度、写记忆免确认各自
  在用到的那一刻 `readWorkspaceMemoryEnabled(workspacePath)`，不缓存成会话状态。
  会话创建时读到的值只用于建目录和迁移，不参与后续判定。

## Pi 主路径

### 注入

新增 Pi inline extension `createMemoryExtension`（必须最后注册）：

```text
before_agent_start
  → 读取 <workspace>/.pi/memory/MEMORY.md
  → 取 event.systemPrompt（其它 handler 写完的完整 prompt）
  → 追加「记忆说明 + 索引」到 systemPromptOptions.forceSystemPrompt
```

- 每个 turn 重读一次，保证本 turn 刚写入的记忆下一轮可见。
- `MEMORY.md` 不存在时只追加说明段，不报错；超过上限或不可读时同样按“不可用”提示，
  不能把“太大”说成“空”。
- 不用 `sections.workspace_memory`：lens/deepseek 实测只改 sections 时，后续 system 消息
  被 provider 丢弃，模型看不到。追加到完整 prompt 并放到最后注册，其他扩展的 section 不会丢。
- 远端不注册扩展；开关关闭时删除 `forceSystemPrompt`。
### 直接写入归一

主模型用 Write/Edit 直接写记忆是主路径，但它不守字段契约：实测会写 `type: convention`
并漏掉 `category` / `source` / `confirmed` / `lastConfirmed`，也常常忘了补 `MEMORY.md`
指针行。宽容解析只能保证“不丢记忆”；索引行、分类展示和过期判定都要规范值，所以在
写入落下之后立刻归一：

```text
tool_result (Write | Edit, isError=false)
  → 目标解析：相对路径按 workspacePath，必须落在 .pi/memory/<item>.md
  → 读文件，normalizeWorkspaceMemoryItem 补全/纠正 frontmatter
  → 内容有变化时原子写回
  → reconcileWorkspaceMemoryIndex 补指针行
```

- 只补/改 frontmatter 的 8 个规范字段；正文与未知字段（`tags:` 等）原样保留。
- 缺 `name` 取文件名；缺 `description` 取正文首个非空行（截断 120 字）。
- 枚举写歪回退缺省（`project` / `fact` / `assistant`）；`confirmed` 非 `true` 即 `false`。
- `lastConfirmed` 缺失或日期非法时写当天 UTC 日期；`expires` 写歪时删掉这一行。
- 已经合规的文件一字不改（幂等），不会反复改写磁盘。
- `MEMORY.md` 本身不参与归一（索引由对账维护）；记忆关闭时不执行。


### 抽取

`HostSessionRegistry` 在 `turnDone`（`agent_settled` 或 `agent_end && !willRetry`）后调度：

```text
  → 能力位为真（本地、非侧聊） && 无 in-flight && 当前开关为开（此刻重读 .pi/picode.json）
  → 取「上次抽取游标之后」的 rows（切片作为后续所有步骤的唯一区间）
  → 能力位为真（本地、非侧聊） && 无 in-flight && 当前开关为开（此刻重读 .pi/picode.json）
  → 取「上次抽取游标之后」的 rows（切片作为后续所有步骤的唯一区间）
turnDone
  → 频率闸门：距上次抽取 >= 3 个 turn，或距上次抽取已过 10 分钟
  → 门禁 1：刚结束的这一轮主模型已 Write/Edit 过记忆文件 → 跳过（避免双写）
  → 门禁 2：这段区间里没有 >= 3 个词的真实用户输入 → 跳过
  → 先对账索引（主模型可能刚写过记忆却没补指针行），再读 MEMORY.md + manifest
  → 按 turn 从头拼区间内的用户/助手消息，单个 turn 不切开，超 24k 就停在断点
    + MEMORY.md + 记忆 manifest + 今天的日期
  → completePiPrompt(抽取模型, 提取 prompt)
  → 解析 JSON patch
  → 游标推进到本次 transcript 实际覆盖到的最后一个 turn
  → 游标推进到本次 transcript 实际覆盖到的最后一个 turn
  → 校验并原子写入 .pi/memory
  → 结束（失败只记日志，不影响 turn）
```

抽取频率与门禁（对应「记忆不要每轮都长」）：

| 约束           | 值                         | 理由                                     |
| -------------- | -------------------------- | ---------------------------------------- |
| 最小 turn 间隔 | 3                          | 短轮次（改错别字、单句追问）不值得抽取   |
| 最小时间间隔   | 10 分钟                    | 长时间空闲的会话也要有一次收敛机会       |
| 直接写入门禁   | 最近一轮已写记忆则跳过抽取 | 主模型 Write 与抽取会写同一事实的两份    |

| 用户散文门禁   | 真实用户消息累计 >= 3 个词 | 工具回执、后台结果、合成消息不该触发抽取 |
门禁与 transcript 必须看**同一个抽取区间**（游标切片），否则一次历史直接写入会把
整个会话后续的抽取永久关掉。直接写入门禁再收窄到「刚结束的这一轮」：区间里更早的
写入已经落盘，拿它拦后续抽取同样会把会话卡死。相对路径按 `workspacePath` 解析，
不是按记忆根：主模型写 `src/index.ts` 不是在写记忆。
两个门禁只影响本次调度：frequency 计数照常推进，不因跳过而回退。
门禁与 transcript 必须看**同一个抽取区间**（游标切片），否则一次历史直接写入会把
整个会话后续的抽取永久关掉。直接写入门禁再收窄到「刚结束的这一轮」：区间里更早的
写入已经落盘，拿它拦后续抽取同样会把会话卡死。相对路径按 `workspacePath` 解析，
不是按记忆根：主模型写 `src/index.ts` 不是在写记忆。

- 同一 session 同时只跑一个抽取；`dispose` 时 abort。
- 抽取成功后才推进游标；解析失败、写入异常时保留这段对话，下次重抽。
- 超时 60s。
- 24k 上限按 turn 从**区间开头**往后拼，超了就停在断点，游标只推进到实际覆盖到的
  最后一个完整 turn。不从尾部裁：尾部裁会把没喂过的早期 turn 标成“已抽取”。
  单个 turn 自己就超 24k 时只取它的前 24k，并让游标越过它。
- `patch` 部分条目被跳过（截断文件禁整份写、append 超 64 KiB）时，调用方拿到
  `skipped` 列表并记 `warn`；只有“什么都没落盘”时才不推进游标，避免重复 append。
  游标滚出投影窗口时退化为整窗重抽，宁可多抽不漏抽。
- 24k 上限按 turn 从**区间开头**往后拼，超了就停在断点，游标只推进到实际覆盖到的
  最后一个完整 turn。不从尾部裁：尾部裁会把没喂过的早期 turn 标成“已抽取”。
  单个 turn 自己就超 24k 时只取它的前 24k，并让游标越过它。
- `patch` 部分条目被跳过（截断文件禁整份写、append 超 64 KiB）时，调用方拿到
  `skipped` 列表并记 `warn`；只有“什么都没落盘”时才不推进游标，避免重复 append。
- `index` 是整份替换。写回前比对抽取开始时的索引快照；期间主模型已改过索引时不写回
- 对账发生在读取 prompt 输入之前：抽取看到的索引与磁盘一致，才不会把“索引里没有”
  误判成“可以删”。抽取 prompt 另外写明 `deletes` 只用于错的、过期的或已合并的记忆，
  不能仅因为某文件不在 `<current_index>` 里就删它。
  模型索引，只落 item 文件，但仍对索引做一次对账。
- 对账发生在读取 prompt 输入之前：抽取看到的索引与磁盘一致，才不会把“索引里没有”
  误判成“可以删”。抽取 prompt 另外写明 `deletes` 只用于错的、过期的或已合并的记忆，
  不能仅因为某文件不在 `<current_index>` 里就删它。
- 落盘后统一调用 `reconcileWorkspaceMemoryIndex`：剔除指向已不存在文件的指针行，
  给磁盘上存在但索引里没有的条目补一行（标题取 frontmatter `name`，悬停取 `description`）。
  索引缺失但磁盘上已有条目时按条目生成索引（空白项目仍不凭空多出 `MEMORY.md`）。
- 抽取 prompt 里带一行 `Today is YYYY-MM-DD (UTC)`：`lastConfirmed` / `expires` 都要求
  模型写真实日期，不给日期就只能猜，过期判定的地基会歪。
- 模型输出必须是 JSON：
  ```json
  {
    "writes": [{ "file": "workflow.md", "content": "..." }],
    "deletes": ["old.md"],
    "index": "- [Workflow](workflow.md) — ...\n"
  }
  ```
- 非法文件名、超限内容、JSON 解析失败 → 整次放弃，不写半成品。
- 抽取 prompt 明确：只使用本轮对话，不调查代码，不重复已有内容。
- 抽取 prompt 必带字段与禁抽规则见下节；`writes` 的 frontmatter 缺字段时按缺省处理。

### 抽取写什么、不写什么

`writes` 的 frontmatter 必须按契约填 `category` / `type` / `source` / `confirmed` /
`lastConfirmed`；更新已有记忆时 `lastConfirmed` 刷新为当天，否则它会被闲置规则清掉。

默认**不抽取**的内容（写进 prompt 的禁止清单）：

- 临时任务状态：正在跑的步骤、当前进度、一次性命令结果、临时分支/端口/进程；
- 能从仓库得到的事实：目录结构、依赖版本、git 历史、`AGENTS.md` 已有规则；
- 会话内的短期上下文：本轮改了哪个文件、刚报的错、待用户回应的问题。

可以通过「一句话能说清、下一周仍然成立」这个判据自查；不满足就不写。
`type: preference` / `constraint` 来自用户明说；`type: decision` 需要写明为什么这么定，
只记结论不记理由的决策等于没记。

### 抽取输入是 manifest，不是全文

抽取请求里每条现有记忆只带「文件名 + description + 前 30 行预览」，不再拼全部正文：

```text
### github-actions-ci.md   (2.1KB, 2026-11-01)
description: CI 只跑 pnpm test，不跑 build
<前 30 行>

### node-version-24.md   (truncated, 48 more lines, 2026-10-28)
description: 必须用 Node 24，mise 已固定
<前 30 行>
```

- 单文件预算：`WORKSPACE_MEMORY_PREVIEW_LINES = 30`；
- 整个 manifest 预算：48 KiB，按 mtime 降序，超预算的剩余文件只计数不展开；
- 最多 200 个文件。

预览被截断（`truncated`）的文件**不允许整体重写**：模型看不到尾部，`writes` 会把后半段丢掉。
修改这类文件只能 `appends` 追加或 `deletes` 删除。

### 索引注入预算

`MEMORY.md` 每次注入都经过 `formatWorkspaceMemoryIndex`：

- 200 行 / 25,000 字符上限；
- 超限截断，并在末尾追加 `> WARNING: MEMORY.md is too long ...` 提示模型压缩；
- 读取上限 1 MiB（防止被外部写入的超大文件卡住），注入内容永远受上面两个上限约束。

写入侧同样度量：模型返回的 `index` 超预算时**不落盘**，改用条目重建的紧凑索引
（每个记忆一行，天然有界）。这样索引不会因为一次抽取变成不可用状态。

### 权限

`createToolPermission` 对以下调用直接 allow：

- 工具映射为 `Write` / `Edit`；
- 目标路径位于 `<workspace>/.pi/memory/` 且以 `.md` 结尾；
- 不是 plan mode，且没有显式 deny / ask 规则。

目录由宿主预创建，不依赖 `bash mkdir`。

## 查看器与接口

`IMemoryService` 改为 workspace-scoped：

```ts
interface ProjectMemoryWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

listProjectMemories(params: {
  workspaces: ProjectMemoryWorkspaceRef[];
}): Promise<ProjectMemoryWorkspaceSummary[]>;

readProjectMemoryFile(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  fileName: string;
}): Promise<{ content: string; updatedAt: number }>;

writeProjectMemoryFile(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  fileName: string;
  content: string;
}): Promise<void>;

deleteProjectMemoryFile(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  fileName: string;
}): Promise<void>;

getWorkspaceMemoryEnabled(params: ProjectMemoryWorkspaceRef): Promise<boolean>;

setWorkspaceMemoryEnabled(
  params: ProjectMemoryWorkspaceRef & { enabled: boolean },
): Promise<void>;
```

- 远端 ref 返回空 / `false`，不读本机同名路径。
- 入口：侧栏每个项目行的「更多」→「项目记忆」。
  - 对话框只读写这个项目自己的 `.pi/picode.json` 和 `.pi/memory`，不依赖当前活动工作区。
  - 顶部是开关和抽取模型，下面是该项目的记忆文件和打开操作。
  - 点击文件在对话框内查看和编辑，可新建、删除；手动保存，`MEMORY.md` 也可编辑。
  - 有未保存修改时，关闭对话框或取消编辑先确认放弃。
  - 远端项目显示“仅本地工作区”，开关禁用。
- 设置页不再提供「记忆」分区；查看入口统一走项目行，避免两个入口分别读取不同项目。
- 旧的全局 `memoryEnabled` 开关移除。

## 抽取模型

项目可以单独指定抽取模型，写在同一份 `<workspace>/.pi/picode.json`：

```json
{
  "features": {
    "memoryModel": { "provider": "lens", "model": "deepseek-v4.1-flash-free" }
  }
}
```

- 缺省、字段不完整或 JSON 损坏：跟随当前会话模型。
- 每轮抽取前重新读配置，改完不用重开会话。
- 配置模型不在 Pi 模型目录时回退会话模型；配置模型请求失败或返回空响应不回退，本轮放弃。
  “模型不存在”和“请求失败”是两件事，不能都当成回退理由。
- 远端工作区不抽取，配置无效。
- UI 在项目记忆对话框里选择，默认“跟随会话模型”。

## 迁移

本地 workspace 首次创建 Pi session 时：

```text
if <workspace>/.pi/memory 不存在或还没有任何 .md:
  oldRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspaceIdentity, workspacePath })
  if oldRoot 存在:
    复制合法记忆文件名（MEMORY.md 或 item 规则）到 <workspace>/.pi/memory（不覆盖已有文件）
  不删除 oldRoot
```

- 每个 workspace 只尝试一次；已存在条目文件但没有索引时**不**迁移，避免把旧项目的
  `MEMORY.md` 混进新记忆。
- 未再打开的项目保持旧数据，不主动扫描全局目录。
- `storageCatalog` 中的 `cli/memories` 保留为 legacy 分类，避免被“清理数据”误删。

## git 忽略

首次创建 `.pi/memory` 时，尽力把 `.pi/memory/` 追加到当前仓库的
`git rev-parse --git-path info/exclude` 指向的文件：

- 只在 git 仓库内执行；
- 已存在则跳过；
- 失败静默，不阻塞记忆功能；
- 不修改 `.gitignore`，不产生可提交的工作区改动。

## 验收场景

1. 本地项目默认关闭：没有 `features.memory` 时不注入、不抽取、不创建目录；项目记忆对话框的开关为关。
2. 项目配置 `features.memory: true`：新建 Pi 会话的 system prompt 含 `MEMORY.md`；宿主写入一条记忆后，
   下一轮注入能看到索引更新。
3. 项目配置改回 false：关闭从下一轮立即停止；再改回 true 恢复注入。
4. `remote:` identity：不注入、不抽取；项目记忆对话框显示“仅本地工作区”。
5. turn 正常结束触发抽取，生成/更新 `.md` 与 `MEMORY.md`；抽取失败不影响 turn 结果。
6. 旧全局记忆在首次打开项目后出现在 `.pi/memory`，旧目录仍保留。
7. 查看器只读项目目录；symlink 目录/文件被拒绝，编辑和删除同样走这层校验。
8. build 模式下写记忆不弹权限确认；plan mode 下仍拦截。
9. `git status` 不显示 `.pi/memory/`。
10. 配置 `features.memoryModel` 后，抽取调用该模型；模型不存在时回退会话模型，抽取仍能完成。
11. 在对话框新建、编辑、删除记忆文件后立即生效；关闭未保存的编辑会先确认放弃。
12. 索引缺失时列表显示 `MEMORY.md`「尚未创建」，点击可创建；抽取只写条目时自动补索引。
13. 连续 2 个短轮次不触发抽取；第 3 个 turn 结束才触发。
14. 本轮主模型已写入记忆文件时，抽取被跳过（不会出现两份同一事实）。
15. 只有工具回执 / 后台结果、没有真实用户文本的轮次不触发抽取。
16. 抽取请求的现有记忆部分是 manifest（文件名 + description + 前 30 行），不是全文。
17. `MEMORY.md` 超过 200 行时注入被截断且带 WARNING；抽取返回超预算索引时不落盘，改重建紧凑索引。
18. 在已有会话里打开项目开关：下一轮就注入 `MEMORY.md`，抽取也会执行，写记忆不再弹确认；
    不需要新建会话。（关闭同理，从下一轮停止。）
19. 侧聊与子会话即使项目开关打开也不注入、不抽取。
20. 第 1、2 轮交代的规则在第 3 轮触发抽取时仍出现在 `<conversation>` 里；
    抽取成功后游标推进，下一次只带新 turn。
21. 抽取只返回 `writes` / `deletes` 不给 `index` 时，`MEMORY.md` 自动补上新文件指针、
    剔除已删文件指针；索引快照过期时同样对账。
    项目里还没有 `MEMORY.md` 时，新建的第一条记忆也要生成索引并出现在下一轮注入里。
    项目里还没有 `MEMORY.md` 时，新建的第一条记忆也要生成索引并出现在下一轮注入里。
22. 在对话框删除条目后，`MEMORY.md` 里指向它的指针行一并消失；新建条目自动补指针。

23. frontmatter 带 `category: ui`：查看器列表显示该分类标记，索引注入内容不变。
24. 缺 `category` / `type` / `lastConfirmed` 的旧记忆文件：正常注入、正常参与抽取，
    按缺省值处理，不被删除、不被改写（归一只作用于主模型本轮的 Write/Edit）。
25. 记忆 mtime 早于阈值且无 `lastConfirmed`：项目显式配了 `features.memoryExpiryDays: 90` 时
    会话创建会把它移到 `.pi/memory/.expired/`，`MEMORY.md` 里的指针行随之消失，列表里不再出现。
26. 记忆带 `lastConfirmed` 为昨天、mtime 为 120 天前：不过期（取较新值）。
27. 未配 `features.memoryExpiryDays`（默认 0）：300 天没编辑、也没 `expires` 的记忆不被清理；
    `expires` 已过的记忆即使昨天刚确认也清理。
28. 配了阈值但 `features.memory: false` 的项目：不清理（清理和记忆同开同关）。
29. 在项目记忆弹窗把「自动清理」改成 30 天：`.pi/picode.json` 的 `features.memoryExpiryDays`
    变成 30，同一文件里的 `features.memory` 与 `features.memoryModel` 保持不变；
30. 主模型在会话里用相对路径（`src/index.ts`）写过任何普通文件：抽取不被跳过；
    只有写 `.pi/memory/*.md` 才跳过。
31. 主模型在第 1 轮直接写过记忆：第 4、7 轮仍然照常抽取（门禁只看刚结束的那一轮）。
32. 区间内容超过 24k：本次只抽到断点，游标停在断点，下一次从断点继续，不重抽已覆盖部分。
33. 抽取 prompt 里含当天日期；模型返回的 `lastConfirmed` 能对上这个日期。
34. 配置的抽取模型已从模型目录删除：回退会话模型；配置模型请求失败或空响应：
    本轮放弃、游标不推进，不回退到会话模型。
35. 主模型用 Write 写 `.pi/memory/test-runner.md`，内容写了 `type: convention` 且缺
    `category` / `source` / `confirmed` / `lastConfirmed`：落盘后文件被补成
    `category: project` / `type: fact` / `source: assistant` / `confirmed: false` / 当天
    `lastConfirmed`，正文不变，`MEMORY.md` 立刻多一行指针，下一轮注入可见。
36. 主模型写 `MEMORY.md` 或 `.pi/memory` 之外的文件：不做归一，也不改索引。
37. 主模型写了记忆文件却没补指针行：抽取开始前先对账，抽取看到的是补全后的索引，
    不会因为“索引里没有”而删掉这个文件。
    改成「不按闲置清理」时存 0，带 `expires` 的记忆仍会到期。

## 失败语义

- 项目配置文件损坏：读取按“未配置”处理（默认关闭），写入抛错，UI 显示错误。
- 记忆目录不可创建：本 session 关闭记忆，日志 `warn`，不影响对话。
- 抽取模型调用失败 / 超时 / 输出非法：放弃本次，日志 `debug`/`warn`，不影响 turn。
- 迁移复制失败：保留旧目录，日志 `warn`，不阻塞 session 创建。
- 清理失败（`.expired` 不可写、文件被占用）：跳过该文件，日志 `warn`，不影响注入与抽取。
- 直接写入归一失败（文件被占用、超限）：跳过本次，日志 `warn`，保留模型写的原样。
- frontmatter 字段非法：按缺省值解析，不丢记忆、不中断注入。
