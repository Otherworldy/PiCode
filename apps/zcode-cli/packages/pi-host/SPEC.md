# Pi Host

ZCode 只做 Pi 的 GUI Host。循环、工具、压缩、extensions、子代理由 Pi 实现。本包是唯一 Agent 适配器。

## 所有权

| 状态 | 所有者 | 派生 |
|---|---|---|
| LLM 上下文 / fork / compact 树 | Pi `SessionManager` jsonl | 适配器不另写对话日志 |
| 屏幕行 / revision / snapshot | `PiToV4Projector` | UI 只读 V4 |
| 队列芯片 / held / autoDrain / sendNow | `HostQueue`（ZCode CommandInbox 语义） | 不投影 Pi `queue_update` |
| 插件 UI 请求 | `ExtensionUiHost` | `pendingInteractions` / widget / status / toast |
| 含子代理的 session | `HostSessionRegistry` | 绕过 spawn 的 child 只显示扁工具卡 |
| 账号与模型目录 | Pi `ModelRuntime`（`~/.pi/agent/auth.json` + `models.json`） | 壳不再强制 ZCode OAuth/登录页。测试可仍注入 delegate stream |
| 工作区 key | `workspaceIdentity?.trim() \|\| workspacePath` | Pi cwd = `workspacePath` |
| 远控 | 现有 Host attachment | 不为手机另起 Pi |

## 事件顺序

```
用户提交
  → HostQueue / V4 CommandInbox 准入（CAS / held / guide|queue|startNow）
  → 准入失败：ACK 拒绝，不调用 Pi
  → idle startNow → session.prompt
    busy guide → session.steer
    busy queue → HostQueue.enqueue，必要时 session.followUp
  → Pi 事件
  → Projector 写 ConversationDelta
  → ConversationTopicPublisher.ingestDeltas
  → desktop-continuous 30ms / web-remote-replayable 150ms
```

同一所有者，两套 flush。jsonl 为对话树真相；V4 snapshot 为 UI/远控派生缓存，可从 jsonl 重建。

## 失败语义

- Pi 拒 prompt（preflight false）：ACK 失败，不造假 turn。
- 流中途失败：turn `failed`，已写出的 row 保留。
- abort：turn `completedInterrupted`，运行中工具 `cancelled`。
- `custom()` 无 adapter：降级 widget 文本，不卡循环。
- 插件抛错：`extension_error` → notify，会话继续。
- 插件直接 `createAgentSession` 绕过 Registry：扁 `toolCall`，无 `workId`，无活动面板。

## V4 命令

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`。

删除（协议 + UI）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、`resumeWorkflowRun`、`startSavedWorkflow`、`amendWorkflowRunSettings`、workspace hook 审核三件套、`switchCollaborationMode`、`applyFileRewind`、`discardSharedContext`。

`switchCollaborationMode` 不恢复为 ZCode 协作模式机。危险工具仍走 ZCode `PermissionService`（Pi 无权限面）：allow 放行、deny 拒绝、ask 用壳 confirm。`mode=yolo` 只作为 PermissionService 的模式输入。

## 死面

壳上拆掉：PluginStore、SavedWorkflows、Automations/OffPeak、CUA、Goal、ZCode 子代理 profile、官方 plugin 商店。设置改为已加载 Pi extensions 列表。

壳上新增：输入框 Extension Widget 槽、会话 Status chips。

## 呈现

| Pi | V4 `toolName` |
|---|---|
| `read` | `Read` |
| `bash` / `powershell` | `Bash` |
| `edit` | `Edit` |
| `write` | `Write` |
| `grep` | `Grep` |
| `find` / `ls` | `Glob` |
| 子代理（经 Registry） | `Agent` |
| 其它 | 原名 → Fallback |

`plugin-adapters` 只提供空 `PluginViewRegistry`。未命中的 `custom()` 降级为 widget 文本。

## 持久化与旧会话

Pi jsonl 按 identity 分目录，是对话树唯一真相。sessions-index 只枚举这些文件里**有过用户消息**的会话（标题 / 时间 / 预览从 jsonl 解析）。打开或冷订阅时 Registry 用同一份 jsonl 重放到 `PiToV4Projector`，V4 snapshot 是派生缓存。无用户消息的空 jsonl 不当会话列出。不打开、不导入旧 ZCode event log。

## Model

主路径：`ModelRuntime.create()` 读 Pi 标准 `auth.json` / `models.json`，`createAgentSession` 不传 `model` 时走 settings 默认或第一个可用模型。壳上不再打开 ZCode WelcomeScreen/登录门禁。

**目录所有者：** Pi `ModelRuntime.getAvailableSnapshot()`。CLI 在 `workspace/readPresentation` 上行目录；Host `IModelSelectionService` 只投影这份目录，不再用 ZCode Provider Registry 当聊天/设置页候选。投影必须把 `getView(input.selection)` 写成 `effectiveSelection`，否则 Composer 触发器拿不到当前草稿模型。Composer 与设置「模型设置」共用该视图。`switchModelConfig` 走 `session.setModel`。

设置页通过 `pi/models` 读写 `~/.pi/agent/models.json`（apiKey 只写不读）和 `settings.json` 默认模型；保存后 `registerProvider`/`unregisterProvider` 更新活着的 `ModelRuntime`。壳不另写 ZCode 供应商库。ZCode 账号登录、升级套餐、Coding Plan 使用统计不再作为产品面。

编辑供应商是双面板：左侧发现/勾选模型，右侧为每个已选模型写 Pi 原生字段。状态所有者仍是 `models.json`，不另建一套绑定表。

|界面|落盘（Pi `models.json` 模型项）|
|---|---|
|别名|`name`|
|上下文窗口|`contextWindow`|
|最大输出|`maxTokens`|
|图片输入|`input` 含 `image`|
|启用的思考等级|`thinkingLevelMap` 的 key；已有 value（含自定义 mapping）保留|
|默认思考等级|附加字段 `defaultThinkingLevel`，仅设置页回显；`ModelRuntime` 不消费|

测试连接复用 `discover`（`GET {baseUrl}/models`），不走旧 ZCode `testModelConnectivity`。不做拖拽排序、高级 Headers/超时、子智能体可用、PDF 能力——Pi schema 没有对应字段。

测试可仍传 `stream`/`delegate` 走隔离 `InMemoryCredentialStore` + `zcode-delegate`，不碰磅真实 Pi 凭证。

## 明确不做

- 用 customTools 包装 ZCode handler
- 渲染进程跑 `pi-tui`
- `pi --mode rpc` 子进程当内核
- 为手机另起 Pi
- 终端 TUI
- 专项插件 renderer（名单后补）
