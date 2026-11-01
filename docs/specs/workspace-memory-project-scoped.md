# 工作区记忆：项目内存储、项目级开关与 Pi 主路径接入

## 背景

当前 Project Memory 存在两套事实：

- 写入 / 注入 / 抽取在旧 `AgentRuntime`（`apps/zcode-cli/packages/core`）里，存储根为
  `<dataRoot>/cli/memories/projects/<slug>-<hash>/memory`。
- V4 Desktop 主路径已经切到 Pi Host（`v4-bridge.createSessionRecord → createPiSessionRecord`）。
  Pi 会话既不读 `MEMORY.md`，也不在 turn 结束后抽取；`pi-session-record.ts` 还把
  `memoryEnabled` 写死为 `false`。自动抽取的唯一调用点随 `cut turn-loop`（3360794）删除。

结果是设置页仍有开关和查看器、历史文件还能读，但新会话不会使用也不会生成记忆。

本次把记忆改成**项目内文件 + 项目级开关**，并接回 Pi 主路径。远端工作区暂不支持。

## 目标

1. 记忆文件存到 `<workspacePath>/.pi/memory/`，跟随项目，不再集中到 app 数据目录。
2. 开关改为项目配置 `<workspacePath>/zcode.json` 的 `features.memory`，缺省关闭。
3. Pi 主路径：每个 turn 注入 `MEMORY.md`；turn 结束后台抽取并写入项目目录。
4. 记忆文件默认被本仓库忽略，不进入 `git status` / diff。
5. 旧全局记忆在首次打开项目时惰性迁移。
6. 远端工作区（`workspaceIdentity` 以 `remote:` 开头）禁用记忆并给出明确提示。

## 非目标

- 远端（SSH / WSL / Docker）记忆读写。
- 团队共享或提交记忆。
- 一次性删除旧 `core/src/memory` 代码；旧路径保留为 legacy，迁移完成后再清理。
- 子代理持久记忆（`.PiCode/agent-memory`）的改造。

## 状态所有者

| 状态               | 所有者                                     | 说明                                    |
| ------------------ | ------------------------------------------ | --------------------------------------- |
| 记忆文件内容       | Pi Host session（写入）                    | `<workspace>/.pi/memory/*.md`           |
| 记忆读取 / 编辑 UI | `IMemoryService`                           | 读写记忆文件与项目开关                  |
| 项目开关           | `<workspace>/zcode.json` `features.memory` | 唯一写入入口 `updateJsonConfigFile`     |
| 启用判定           | Pi extension 每轮读 `zcode.json`           | 只有显式 `features.memory: true` 才开启 |
| 自动抽取调度       | `HostSessionRegistry`                      | 每个 session 同时最多一个 in-flight     |
| 旧数据迁移         | `createPiSessionRecord`                    | 本地 workspace 首次创建时惰性复制       |

全局 app 设置 `memoryEnabled` 不再参与判定，设置页不再暴露；字段保留仅为兼容旧 `setting.json`。
项目开关在每个 turn 重新读取，关闭后下一轮即停止注入与抽取，不必重开会话。

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

## 开关与优先级

```text
remote workspace           → 强制关闭
features.memory === true   → 开启
features.memory === false  → 关闭
memory.use === true        → 开启（CLI 兼容）
否则                       → 关闭
```

- 开关只写 `<workspace>/zcode.json`，只改 `features.memory`，保留其它键。
- 读写必须走 `updateJsonConfigFile`（文件锁 + 原子写），不新增裸 `writeFile`。
- 全局 `memoryEnabled` 字段保留但忽略；旧值不迁移成项目开关，避免把“全局开”批量写进所有项目。
- Pi extension 与抽取调度在每个 turn 重新读开关；关闭后下一轮删除已注入的 section 并停止抽取。

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

### 抽取

`HostSessionRegistry` 在 `turnDone`（`agent_settled` 或 `agent_end && !willRetry`）后调度：

```text
turnDone
  → 条件：创建时 enabled && 本地 && 无 in-flight && 当前开关仍为开
  → 只取本轮 turnId 的用户/助手消息 + MEMORY.md + 文件清单
  → completePiPrompt(当前模型, 提取 prompt)
  → 解析 JSON patch
  → 校验并原子写入 .pi/memory
  → 结束（失败只记日志，不影响 turn）
```

- 同一 session 同时只跑一个抽取；`dispose` 时 abort。
- 超时 60s。
- `index` 是整份替换。写回前比对抽取开始时的索引快照；期间主模型已改过索引时跳过
  索引写入，只落 item 文件，避免旧快照覆盖刚追加的指针行。
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
  - 对话框只读写这个项目自己的 `zcode.json` 和 `.pi/memory`，不依赖当前活动工作区。
  - 顶部是开关和抽取模型，下面是该项目的记忆文件和打开操作。
  - 点击文件在对话框内查看和编辑，可新建、删除；手动保存，`MEMORY.md` 也可编辑。
  - 有未保存修改时，关闭对话框或取消编辑先确认放弃。
  - 远端项目显示“仅本地工作区”，开关禁用。
- 设置页不再提供「记忆」分区；查看入口统一走项目行，避免两个入口分别读取不同项目。
- 旧的全局 `memoryEnabled` 开关移除。

## 抽取模型

项目可以单独指定抽取模型，写在同一份 `<workspace>/zcode.json`：

```json
{
  "features": {
    "memoryModel": { "provider": "lens", "model": "deepseek-v4.1-flash-free" }
  }
}
```

- 缺省、字段不完整或 JSON 损坏：跟随当前会话模型。
- 每轮抽取前重新读配置，改完不用重开会话。
- 配置模型不在 Pi 模型目录时回退会话模型；配置模型请求失败不回退重试，本轮放弃。
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

## 失败语义

- 项目配置文件损坏：读取按“未配置”处理（默认关闭），写入抛错，UI 显示错误。
- 记忆目录不可创建：本 session 关闭记忆，日志 `warn`，不影响对话。
- 抽取模型调用失败 / 超时 / 输出非法：放弃本次，日志 `debug`/`warn`，不影响 turn。
- 迁移复制失败：保留旧目录，日志 `warn`，不阻塞 session 创建。
