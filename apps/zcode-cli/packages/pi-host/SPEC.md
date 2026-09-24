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

- Pi 拒 prompt（preflight false）：ACK 失败，不造假 turn。rewind 之后、重发完成之前的任何失败，都用 jsonl 把原对话行画回去。
- `getModel()` 返回 `provider/model`。旧 snapshot 把裸模型 id 当成非法选择，会在截断之后把编辑打失败。
- 新建会话的 Pi 投影增量写入 sessions-index。只跳过纯文本流式 delta。第一条用户消息同时成为侧栏标题。
- 流中途失败：turn `failed`，已写出的 row 保留。
- abort：turn `completedInterrupted`，运行中工具 `cancelled`。
- `custom()` 无 adapter：降级 widget 文本，不卡循环。
- 插件抛错：`extension_error` → notify，会话继续。
- Pi extension 注册的工具和 ZCode 的 customTools 一起进上游 `tools`。`noTools: "builtin"` 只关掉同名内置工具，不传 `tools` 白名单。
- ZCode 不再注册 `TodoRead` / `TodoWrite`，也不再提醒模型去调用它们。旧会话里的 todo 卡片和进程投影仍按工具名渲染。
- 桌面和 CLI 同一份 `zcode.cjs` 把 Pi 打进 CJS。入口先设 `globalThis.PI_BUNDLED_NODE`，Pi 才用内嵌模块表加载 extension，而不是按 bundle 路径去找 `../dist/babel.cjs`。`import.meta.url` 不能改写成 `module.filename`：extension loader 同一个函数里有 `const module`，那个标识符在死区里，extension 会在 import 之前就失败。文件名改记在 `globalThis.__zcodeBundleFilename`。
- 插件后台任务打到已失效的 extension ctx 时，app-server 只记一行并继续。这个拒绝不能把进程打退出。
- 插件直接 `createAgentSession` 绕过 Registry：扁 `toolCall`，无 `workId`，无活动面板。

## V4 命令

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`。

删除（协议 + UI）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、`resumeWorkflowRun`、`startSavedWorkflow`、`amendWorkflowRunSettings`、workspace hook 审核三件套、`switchCollaborationMode`、`applyFileRewind`、`discardSharedContext`。

`switchCollaborationMode` 不恢复为 ZCode 协作模式机。危险工具仍走 ZCode `PermissionService`（Pi 无权限面）：allow 放行、deny 拒绝、ask 投影 `kind: permission` 给壳 PermissionDialog（Allow once / Allow for session / Block）。session allow 由 HostedSession 记忆。`mode=yolo` 只作为 PermissionService 的模式输入。插件 `confirm/select` 仍走底栏 userInput，不用 viewport overlay。

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

## 子代理面板

目录和只读侧栏仍用现有 V4 `subagents` 字段。子运行的 jsonl 写在父会话文件同名目录下，面板仍读这份文件。不读 ZCode `subagent_child` 会话库，也不依赖 `pi-subagents` 插件是否安装。

设置页拥有代理定义：用户 `~/.zcode/agents`，项目 `<workspace>/.zcode/agents`，内置 `general-purpose` / `Explore`。Pi 会话挂一个 `zcode_subagent` 工具，按这份定义起子会话。子会话不再挂这个工具，也不挂 MCP。同名的 Pi 插件工具 `subagent` 在主会话上禁用，避免两套定义争用。

## MCP

设置页写入的 MCP（`~/.zcode/cli/config.json` 的 `mcp.servers`）由 ZCode 的 `McpPort` 调用，不读 Pi 自己的 MCP 配置。默认只注册一个 `mcp` 代理工具：先列服务器，再按服务器搜索或描述工具，最后 `tool` + `args` 调用。服务器在第一次被代理用到时才连接。某个 server 设 `directTools: true` 时，才在会话创建时连接并把它的工具逐个注册成 Pi 工具。`enabled: false` 不连接。连接失败只记一条警告，不阻止会话创建。

## 持久化与旧会话

对话树真相是 Pi jsonl，与 Pi TUI 共用 `~/.pi/agent/sessions/<encoded-cwd>/`（文件名 `timestamp_<id>.jsonl`，header id 为 sessionId）。新建/fork 写这里，不预建空文件（Pi 在首条 assistant 落盘）。仍枚举旧 `~/.zcode/pi-host-sessions/<identity>/` 以免丢本 Host 已写过的会话。sessions-index 只列出有过用户消息（或 `session_info.name`）的文件。壳项目列表以这份摘要为行集合，tasks-index 只提供 pin/archive/unread。打开或冷订阅时 Registry 用同一份 jsonl 重放到 `PiToV4Projector`。不打开、不导入旧 ZCode event log。

## Model

主路径：`ModelRuntime.create()` 读 Pi 标准 `auth.json` / `models.json`，`createAgentSession` 不传 `model` 时走 settings 默认或第一个可用模型。壳上不再打开 ZCode WelcomeScreen/登录门禁。

设置页的 HTTP 代理和「不使用代理的地址」仍写 `AppSettings`，由 Host 在拉起 agent 时注入 `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY`。CLI 仍会清掉进程里的标准 `HTTP_PROXY` / `NO_PROXY`，避免用户 shell 代理泄漏。清完之后只把这两个 ZCODE 值写回标准变量，并用已有的 `createNetworkProxyFetch` 换掉 `globalThis.fetch`。Pi 模型请求走这层 fetch；Pi bash 继承进程环境，curl/git 因此读到同一套规则。绕过规则与旧模型出口相同（主机、前缀点、端口、`*`）。没配代理则不换 fetch。改设置后下次启动 agent 生效。MCP 仍走原来的 `McpPort` 网络配置，不另开一条代理。

**目录所有者：** Pi `ModelRuntime.getAvailableSnapshot()`。CLI 在 `workspace/readPresentation` 上行目录；Host `IModelSelectionService` 只投影这份目录，不再用 ZCode Provider Registry 当聊天/设置页候选。投影必须把 `getView(input.selection)` 写成 `effectiveSelection`，否则 Composer 触发器拿不到当前草稿模型。Composer 与设置「模型设置」共用该视图。`switchModelConfig` 走 `session.setModel`。

设置页通过 `pi/models` 读写 `~/.pi/agent/models.json`（apiKey 只写不读）和 `settings.json` 默认模型；保存后 `registerProvider`/`unregisterProvider` 更新活着的 `ModelRuntime`。壳不另写 ZCode 供应商库。ZCode 账号登录、升级套餐、Coding Plan 使用统计不再作为产品面。

## Pi 插件开关

设置「插件」页只列 Pi 已配置的包和自动发现的扩展文件。状态所有者是 Pi `settings.json`：用户级 `~/.pi/agent/settings.json`，工作区级 `<cwd>/.pi/settings.json`。`pi/plugins` 的 `list` 读这两处；`setEnabled` 写回后 `flush`。包的关是 `packages[].autoload: false`（保留已有过滤）；扩展文件的关是追加或拿掉精确的 `-<相对路径>`。已打开的会话不热更新，下一次创建会话才按新开关加载。不写 ZCode 插件启用表，也不再把 ZCode 插件市场当能力源。`plugins/*` 协议方法已删除，设置页不再列、安装或开关 ZCode 插件。

技能设置读写 Pi 会加载的目录：用户 `~/.pi/agent/skills`，工作区 `<cwd>/.pi/skills`，仍列出 Pi 同样会读的 `.agents/skills`。命令设置读写 Pi 提示词目录：用户 `~/.pi/agent/prompts`，工作区 `<cwd>/.pi/prompts`。钩子不进入 Pi 会话，设置页不再单独列出。

内置浏览器是宿主能力，不是可安装插件。会话创建时直接连上打包好的 `node_repl`，并把 `control-browser` 技能交给 Pi。工具名仍是 `mcp__node_repl__js`。direct 调用带上当前会话 id，browser broker 才能回到 `BrowserControlPort`，再调 Electron `interaction/browserExecute`。不写进用户 MCP 配置。开关在 `~/.zcode/v2/setting.json` 的 `browserHostEnabled`，缺省开启，只影响之后新建的会话。子会话不带这个工具。

SSH 工作区不部署远端 zcode-server，也不从 ZCode CDN 下载或上传运行时。状态所有者仍是本机 Pi：模型读本机 `~/.pi/agent`，会话 jsonl 写在本机。窗口 Host 只记住该 workspace identity 对应的 SSH 目标（别名优先，否则 `user@host` 加端口），并在拉起本机 agent 时放进 `ZCODE_SSH_REMOTE`。这个进程里的 read / write / edit / bash / ls / grep / find 经系统 `ssh` 作用在远端路径上。Pi 在 Windows 上会把远端路径 resolve 成盘符路径；会话提示改回远端 posix 路径，命令里的盘符前缀在执行前换回去。bash 的 timeout 按秒计。会话 jsonl 按 workspace identity 分目录，侧栏才能列出来；目录选择的默认路径是远端 `/home`。密码和私钥不进环境变量；认证失败就失败，不回退到远端安装。WSL 和 Docker 仍走原来的远端 server。

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

- 用 customTools 包装 ZCode 旧工具 handler。子代理和 MCP 例外：这两项由 ZCode 持有定义，Pi 只负责调用
- 渲染进程跑 `pi-tui`
- `pi --mode rpc` 子进程当内核
- 为手机另起 Pi
- 终端 TUI
- 专项插件 renderer（名单后补）
- `AskUserQuestion` 与设置项「提问自动继续」。当前会话不注册这个工具，也不再按 5 分钟自动结束提问。权限确认和计划审批仍走原来的交互。
