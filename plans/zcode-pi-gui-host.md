# ZCode 作为 Pi GUI Host

## Context

ZCode 开源后的目标不是「把 Pi 塞进现有 AgentRuntime」，而是控制权反转：

- **壳**：现有 Desktop / Web / 远控 UI 与 V4 协议。
- **脑**：Pi `AgentSession`（循环、压缩、重试、内置工具、extensions、子代理）。
- **适配器**：新建 Pi Host，把 Pi 事件/插件 UI 投到现有 V4 行、弹窗、队列。

ZCode 不再实现工具、turn loop、子代理调度、动态工作流、CUA、Cron。这些由 Pi 内置工具 + `~/.pi/agent/extensions` / 项目 `.pi/extensions` 提供。

不包一层旧 ZCode 工具。不仿真 `pi-tui` 组件树。通用插件 UI = Pi 官方 RPC Extension UI 协议映射到壳原语。专项 `plugin-adapters` 只留登记表空壳，名单后补。

## Approach

在 `apps/zcode-cli` 新增 `@zcode/pi-host`。`app-server --stdio` 仍由 Desktop 拉起，但内部不再 `new AgentRuntime()` 跑模型，改为 `HostSessionRegistry` 创建 Pi session。

所有权：

| 状态 | 所有者 |
|---|---|
| LLM 上下文 / fork / compact 树 | Pi `SessionManager` jsonl |
| 屏幕行 / revision / snapshot | `PiToV4Projector` |
| 队列芯片 / held / autoDrain / sendNow | 现有 CommandInbox |
| 插件 UI 请求 | `ExtensionUiHost` |
| 含子代理的所有 session | `HostSessionRegistry`（绕过则只显示扁工具卡） |
| 账号与模型目录 | 现有 ZCode provider UI；底下 Pi Model delegate |
| 工作区 key | `workspaceIdentity \|\| workspacePath`；Pi cwd = `workspacePath` |
| 远控 | 现有 Host attachment；不为手机另起 Pi |

Desktop `continuous` 与手机 `replayable` 同一投影所有者、两套 flush。

## 已确认

- 壳可改：拆工作流 / CUA / 插件市场 / Goal / OffPeak 等死面；加输入框 Widget 槽与会话 Status chips。
- 专项插件 GUI：先做通用层，`plugin-adapters` 只留空登记表，名单后补。
- 旧 ZCode 会话：不管。列表与续跑只认 Pi jsonl，不导入、不只读打开旧 event log。
- 删除原 `zcode` 终端 TUI（`@zcode/tui` 与无参进 TUI 分流）。保留 `app-server` 与 `zcode --web`。无参改为 `--help`。

## Files to modify

新建：

- `apps/zcode-cli/packages/pi-host/`（session-registry、command-bridge、projector、extension-ui-host、presentation、model-delegate、plugin-adapters）
- `apps/zcode-cli/packages/pi-host` 的架构模块登记（`architecture-policy.yaml` 现 `zcode-cli` 为 unmanaged；新包先跟 CLI 走，不单独造 managed 模块除非跨包）
- `packages/shared/src/zcode-protocol-v4/`：删死命令；snapshot 增 `extensionWidgets` / `extensionStatuses`
- `packages/ui/src/`：Widget 槽、Status chips、`PluginToolViewRegistry`；从 `WorkspaceShellLayout.tsx` / settings 拆 PluginStore、SavedWorkflows、Automations/OffPeak、CUA 入口
- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`：装配改走 Pi Host
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`：command handler 改调 Host，不再 `runtime.executeTurn`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-*.ts`：冷启动种子改为 Pi jsonl，禁止 `sessionStore.listSessions` 灌旧会话
- `apps/zcode-cli/packages/cli/src/run.ts`、`tui-command.ts`、`tui-stderr.ts`：删除 TUI 分流
- 删除包 `apps/zcode-cli/packages/tui/`

删除/移出主路径（步骤里收口，不双轨长期共存）：

- `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts` 及 AgentRuntime 模型循环
- `apps/zcode-cli/packages/core/src/tool/handlers/*` 作为能力源
- dynamic-workflow / CUA / Cron / OffPeak / ZCode Agent-Task 端口
- ZCode marketplace 作为运行时插件源

## Reuse

- V4 命令信封、CAS、`startPromptTurn` 准入边界：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`
- CommandInbox / sendInput 外观：`apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`
- 工具行 schema：`packages/shared/src/zcode-protocol-v4/rows.ts`（`toolCallRowSchema` 已通用）
- 未知工具兜底卡：`packages/ui/src/ToolCallBlocks/renderers/fallback.tsx`
- 按 family 的精美卡：`packages/ui/src/ToolCallBlocks/resolveRenderer.ts`、`packages/ui/src/lib/toolIdentity.ts`
- 问答/权限窗：`packages/ui/src/v4/V4InteractionDialogs.tsx`、`resolveInteraction`
- 子代理来源徽标：`packages/ui/src/InteractionRequestOriginBadge.tsx`
- 投递档：`packages/shared/src/zcode-protocol-v4/core.ts` `DELIVERY_PROFILES`
- Desktop 拉起：`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`（`app-server --stdio`）
- 模型请求：`apps/zcode-cli/packages/bootstrap/src/model-factory.ts`（delegate 接到这里）
- Pi SDK：`createAgentSession` / `createAgentSessionRuntime`、`defineTool` 不用；extensions 用 `DefaultResourceLoader`
- Pi 插件 UI 契约：官方 RPC `extension_ui_request/response`（select/confirm/input/editor/notify/setStatus/setWidget）；`custom()` 不仿真

内置工具名映射（呈现，不是包一层旧 handler）：

| Pi | V4 `toolName` | 现有卡 |
|---|---|---|
| `read` | `Read` | Read |
| `bash` / `powershell` | `Bash` | Execute |
| `edit` | `Edit` | Edit |
| `write` | `Write` | Write |
| `grep` / `find` / `ls` | `Grep` / `Glob` | Search |

## Steps

每步有可验收目标。后一步依赖前一步的契约，不保留旧循环双轨。

### 步骤 0 — 规格与边界落盘

- [x] 在 `apps/zcode-cli/packages/pi-host/SPEC.md` 写下所有权、事件顺序、失败语义、死面清单、V4 保留/删除命令。仓库没有现成 spec 目录，跟包走。
- [x] `plugin-adapters` 只定义 `PluginViewRegistry` 接口与空表，不实现具体插件。

**目标：** 实现时不再争论「ZCode 工具要不要包一层」或「要不要迁旧会话」。

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`。

删除（协议 + UI 同期）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、工作流三件套、workspace hook 审核、ZCode 协作模式机。`applyFileRewind` 保留：用该轮 Pi `edit` 的 oldText/newText 退文件，不截断聊天。

### 步骤 1 — Pi Host 骨架与空会话

- [x] 新建 `apps/zcode-cli/packages/pi-host`，workspace 接入，依赖 `@earendil-works/pi-coding-agent`（或当时官方包名）。
- [x] `HostSessionRegistry`：按 identity 建/毁 `AgentSessionRuntime`；`SessionManager` 用 Pi jsonl；cwd = `workspacePath`。
- [x] `ModelDelegate`：Pi `Model.stream` 调现有 ZCode `modelFactory`，不读 `~/.pi/agent/auth.json`。
- [x] `createSession` 走 Registry；stdout 仍是 V4，console 继续进 stderr（现有 `protocol-console`）。
- [x] sessions-index 只枚举 Pi jsonl；旧 ZCode `sessionStore` 记录不出现在侧栏。
- [x] 先不加载 extensions。

**目标：** 能开会话、切模型、进程不污染 V4 帧。侧栏从空列表开始。无工具也可存在。

### 步骤 2 — 命令桥：发送 / 停 / 压 / 队列

- [x] `command-bridge`：Inbox 准入后 idle → `prompt`，guide → `steer`，queue → `followUp`。
- [x] `stop` → `abort`；`compact` → `compact`。
- [x] 队列编辑/重排/sendNow/autoDrain 只改 Inbox，再决定是否投递 Pi。禁止用 Pi `queue_update` 当芯片真相。
- [x] `setFollowupMode` 同时改 Inbox 与 Pi steering/followUp mode。

**目标：** 壳上输入条、停止、压缩、队列行为与现在一致，后端已是 Pi。

### 步骤 3 — Projector：对话可画

- [x] 新建 `PiToV4Projector`，**不**再进 `EventReducer` 主路径。
- [x] 映射：`agent_start`→turnHeader；user 消息→userInput；`text_delta`/`thinking_delta`→assistant delta；`agent_settled`→turn 终态；compaction；abort。
- [x] 实现 revision、entityId、coalesce、`DELIVERY_PROFILES` 两档。
- [x] jsonl 为对话树真相；V4 snapshot 为 UI/远控派生缓存，可从 jsonl 重建。

**目标：** 纯文本对话在桌面 live 与手机 replay 都能看、能停、能重连。

### 步骤 4 — 内置工具呈现

- [x] 打开 Pi 内置 `read/bash/edit/write`（按需 grep/find/ls）。
- [x] presentation 层做上表名字与 details 对齐（edit 的 diff/patch → Edit 卡字段）。
- [x] `tool_execution_*` → `toolCall` 行状态机（inputStreaming / running / success / error / cancelled）+ `outputPreview`。
- [x] 不调用 ZCode `ToolExecutor` / handlers。

**目标：** 四张现有精美卡工作；未知工具走 Fallback。

### 步骤 5 — Extension 加载与通用插件 UI

- [x] `DefaultResourceLoader` 加载 `~/.pi/agent/extensions` 与项目 `.pi/extensions`。
- [x] `project_trust` → 壳 confirm。
- [x] `ExtensionUiHost` 实现 RPC 同构：`select/confirm/input/editor` → `pendingInteractions`；`notify` → toast；`setStatus`/`setWidget` → 新槽；`set_editor_text` → 草稿；`setTitle` → 窗口标题。
- [x] 对插件宣称 `ctx.mode === "rpc"`、`ctx.hasUI === true`。
- [x] `custom()`：查 `PluginViewRegistry`，未命中则降级为 widget 文本，不解释 TUI 树。
- [x] 未知 `registerTool` → Fallback 卡。

**目标：** 标准目录里「只会 dialog/notify/widget」的插件可在桌面壳使用。

### 步骤 6 — 子代理

- [x] Registry 提供 `spawn(parentId)`；包装注入 extension 的 API，子 session 必须经此门。
- [x] 投影：parent 上 Agent/Task 族卡片 + `workId`；child 事件为平铺 row，`origin.kind=subagent`。
- [x] `cancelBackgroundWork(workId)` abort 对应 child。
- [x] child 的 `ctx.ui` 同样进 Host，弹窗带来源徽标。
- [x] 插件直接 `import { createAgentSession }`：只显示扁工具卡，不进活动面板。

**目标：** 经 Registry 的子代理能看、能停、能问答；不复活 ZCode child `AgentRuntime`。

### 步骤 7 — 会话树命令与侧会话

- [x] `forkAssistant` / `editUserQuery` / `retryTurn` → `fork` / `navigateTree` + 再 prompt。
- [x] `createSelectionSideSession` → 同 workspace 第二个 Registry session。
- [x] `renameSession` / `deleteSession` → Pi session 名 + 删 jsonl + 现有会话索引。
- [x] `setAssistantFeedback` 只写投影元数据。

**目标：** 壳上分叉、改问、重试、侧栏会话不依赖旧 event log。

### 步骤 8 — 壳减死面 + 插件槽 + 空登记表

- [x] UI 增加输入框上下 Extension Widget 槽、会话 Status chips。
- [x] `PluginToolViewRegistry` 空表：未命中走 Fallback / widget 文本。
- [x] 拆入口：`PluginStorePage`、SavedWorkflows、Automations/OffPeak、CUA、Goal；设置改为「已加载 Pi extensions」列表（读标准目录）。
- [x] 权限不再走 ZCode `PermissionService` 词表；危险操作为插件 `confirm/block`。可留一个「自动同意 confirm」开关代替 yolo，不恢复协作模式状态机。

**目标：** 壳上没有假入口；dialog/notify/widget 通用层完整；专项 GUI 可后补而不改契约。

### 步骤 9 — 收口删除旧循环与终端 TUI

- [x] `create-app` / V4 handlers 去掉对 `AgentRuntime.executeTurn` 的依赖。
- [x] 删除或停止编译 turn-loop、内置 handlers、workflow/CUA/Cron 主路径。`executeTurn`/`executeTurnCommand` 已切断；`turn-loop.ts` 停止编译。create-app 仍装配未接主路径的 workflow 端口（残留，不跑循环）。
- [x] 删除 `@zcode/tui`：`apps/zcode-cli/packages/tui/`，以及 `cli/src/tui-*.ts`、`run.ts` 里 `runTuiCommand`。无参不再 `(positional ?? "tui") === "tui"`。
- [x] `zcode --web` 与 `app-server --stdio` 保留。无参输出 help。
- [x] 更新 `AGENTS.md` / README：Agent 能力源是 Pi；不再提供终端 TUI；UI 禁止再假设 ZCode 工具名（除 presentation 映射表）。
- [x] `pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint`。

**目标：** 仓库主路径只有一个循环，没有第二套终端 Agent UI。

## Verification

自动化（按仓库现有包，不假设统一 E2E 入口）：

- [x] pi-host 单测：事件→row（text、tool、abort、compact）、Inbox 投递、名字映射、extension_ui request/response。
- [x] projector 两档：continuous 有 text/inputText 流式；replayable 有 tool progress、无过度 inputText 流。
- [x] 子代理：Registry spawn 产生 workId；绕过 spawn 无 workId。
- [x] `pnpm typecheck` 与 `pnpm lint` 报真实结果。

手工：

- [ ] `pnpm dev:desktop`：开会话、发消息、Read/Bash/Edit/Write、停止、压缩、队列 guide/queue。
- [ ] 放一个只用 `confirm/select` 的测试 extension 到 `~/.pi/agent/extensions`，弹窗可回答。
- [ ] `setWidget`/`setStatus` 能在输入区/状态条看到。
- [ ] 远程/手机重连走 replayable，不丢 turn 终态。
- [ ] 登录仍用 ZCode 账号，请求不落到 Pi `auth.json`。
- [ ] 死面入口已消失；工作流命令不再出现在协议面。
- [ ] 首次打开侧栏不出现旧 ZCode 会话。
- [x] `zcode` 无参不再进 TUI；`zcode --web` 仍能起 Web 壳。

## 明确不做

- 用 customTools 包装 ZCode 旧 handler。
- 在渲染进程跑 `pi-tui` 或通用 TUI→React。
- `pi --mode rpc` 子进程当内核（Node 内嵌 SDK）。
- 为手机另起 Agent/Pi。
- 打开、导入或迁移旧 ZCode 会话。
- 把 ZCode marketplace 桥成 Pi 加载器。
- 保留或改接原 `zcode` 终端 TUI。
- 在未提供名单前进专项插件 renderer。
