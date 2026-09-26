# Pi Host

PiCode 只做 Pi 的 GUI Host。循环、工具、压缩、extensions、子代理由 Pi 实现。本包是唯一 Agent 适配器。

## 所有权

| 状态 | 所有者 | 派生 |
|---|---|---|
| LLM 上下文 / fork / compact 树 | Pi `SessionManager` jsonl | 适配器不另写对话日志 |
| 屏幕行 / revision / snapshot | `PiToV4Projector` | UI 只读 V4 |
| 队列芯片 / held / autoDrain / sendNow | `HostQueue`（PiCode CommandInbox 语义） | 不投影 Pi `queue_update` |
| 插件 UI 请求 | `ExtensionUiHost` | `pendingInteractions` / widget / status / toast |
| 含子代理的 session | `HostSessionRegistry` | 绕过 spawn 的 child 只显示扁工具卡 |
| 账号与模型目录 | Pi `ModelRuntime`（`~/.pi/agent/auth.json` + `models.json`） | 壳不再强制 PiCode OAuth/登录页。测试可仍注入 delegate stream |
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
- 模型失败只把一句摘要写进回复和 `lastError.message`；原始 JSON 放 `lastError.detail`。
- Pi `auto_retry_start` 写入 `control.apiRetry.failures`。最终失败只进输入框上方的原错误横幅，摘要一行，历次失败和原文在「展开详情」。不写成助手正文。成功后清掉重试状态。同一次失败的后续 `agent_settled` 不清掉这条错误。
- `/compact` 直接调用 Pi `session.compact()`，不进入输入队列。Pi 会先中断当前操作再压缩。完成后的摘要写在 compact marker 的 `summary` 上，界面可展开查看。重开会话时从 jsonl 的 compaction 条目还原同一条 marker。
- 输入框模型左侧的圆环读 Pi `getContextUsage()`。一轮结束、压缩结束或切换模型后写入 `usage.contextWindow`。点击圆环发送 `/compact`。
- abort：turn `completedInterrupted`，运行中工具 `cancelled`。
- `custom()` 无 adapter：降级 widget 文本，不卡循环。
- 插件抛错：`extension_error` → notify，会话继续。
- Pi extension 注册的工具和 PiCode 的 customTools 一起进上游 `tools`。`noTools: "builtin"` 只关掉同名内置工具，不传 `tools` 白名单。
- PiCode 不再注册 `TodoRead` / `TodoWrite`，也不再提醒模型去调用它们。旧会话里的 todo 卡片和进程投影仍按工具名渲染。
- 桌面和 CLI 同一份 `zcode.cjs` 把 Pi 打进 CJS。入口先设 `globalThis.PI_BUNDLED_NODE`，Pi 才用内嵌模块表加载 extension，而不是按 bundle 路径去找 `../dist/babel.cjs`。`import.meta.url` 不能改写成 `module.filename`：extension loader 同一个函数里有 `const module`，那个标识符在死区里，extension 会在 import 之前就失败。文件名改记在 `globalThis.__zcodeBundleFilename`。
- 插件后台任务打到已失效的 extension ctx 时，app-server 只记一行并继续。这个拒绝不能把进程打退出。
- 插件直接 `createAgentSession` 绕过 Registry：扁 `toolCall`，无 `workId`，无活动面板。

## V4 命令

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`、`applyFileRewind`。

删除（协议 + UI）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、`resumeWorkflowRun`、`startSavedWorkflow`、`amendWorkflowRunSettings`、workspace hook 审核三件套、`switchCollaborationMode`、`discardSharedContext`。

`applyFileRewind` 只退这一轮的文件，不截断聊天。真相是这一轮成功的 Pi 工具参数，不是旧 checkpoint。`edit` 要当前文件仍能唯一匹配 `newText` 才写回 `oldText`。`write` 要当前内容仍等于写入内容才删除该文件；覆盖掉的旧内容找不回来。对不上就整批不写。`bash` 只记为忽略，不阻止文件摘要上的撤销；编辑消息并选了回滚文件时，有忽略项仍拒绝。成功后把该轮 `fileChanges.state` 改成 `reverted`。SSH 工作区走和工具同一条远端读写。

`switchCollaborationMode` 不恢复为 PiCode 协作模式机。危险工具仍走 PiCode `PermissionService`（Pi 无权限面）：allow 放行、deny 拒绝、ask 投影 `kind: permission` 给壳 PermissionDialog（Allow once / Allow for session / Block）。session allow 由 HostedSession 记忆。`mode=yolo` 直接放行全部工具，不再弹权限窗。插件 `confirm` 视为同意。`select` / `input` / `editor` 仍进底栏等人答，完全访问也不代答。其它模式的 `confirm/select` 同样走底栏 userInput，不用 viewport overlay。

## 死面

壳上拆掉：PluginStore、SavedWorkflows、Automations/OffPeak、CUA、Goal、PiCode 子代理 profile、官方 plugin 商店。设置改为已加载 Pi extensions 列表。

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

目录和只读侧栏仍用现有 V4 `subagents` 字段。子运行的 jsonl 写在父会话文件同名目录下，面板仍读这份文件。不读 PiCode `subagent_child` 会话库，也不依赖 `pi-subagents` 插件是否安装。

设置页拥有代理定义：用户 `~/.PiCode/agents`，项目 `<workspace>/.PiCode/agents`，内置 `general-purpose` / `Explore`。Pi 会话挂一个 `zcode_subagent` 工具，按这份定义起子会话。子会话不再挂这个工具，也不挂 MCP。同名的 Pi 插件工具 `subagent` 在主会话上禁用，避免两套定义争用。

## MCP

设置页写入的 MCP（`~/.PiCode/cli/config.json` 的 `mcp.servers`）由 PiCode 的 `McpPort` 调用，不读 Pi 自己的 MCP 配置。默认只注册一个 `mcp` 代理工具：先列服务器，再按服务器搜索或描述工具，最后 `tool` + `args` 调用。服务器在第一次被代理用到时才连接。某个 server 设 `directTools: true` 时，才在会话创建时连接并把它的工具逐个注册成 Pi 工具。`enabled: false` 不连接。连接失败只记一条警告，不阻止会话创建。

## 持久化与旧会话

对话树真相是 Pi jsonl，与 Pi TUI 共用 `~/.pi/agent/sessions/<encoded-cwd>/`（文件名 `timestamp_<id>.jsonl`，header id 为 sessionId）。新建/fork 写这里，不预建空文件（Pi 在首条 assistant 落盘）。仍枚举旧 `~/.PiCode/pi-host-sessions/<identity>/` 以免丢本 Host 已写过的会话；文件名是 `timestamp_<id>.jsonl` 时列表 id 用 header，不用整段文件名。列表时间用会话 header 和最后一条用户/助手消息；分叉抄来的旧消息、以及打开时写入的 label，都不能改这个时间。sessions-index 只列出有过用户消息（或 `session_info.name`）的文件。删除会话时关掉活着的 runtime，并删掉该 id 在本机目录和旧 hosted 目录里的 jsonl；列表行随后消失，不留可恢复的副本。壳项目列表以这份摘要为行集合，tasks-index 只提供 pin/archive/unread。重开只画当前叶子到根的那条分支，文件里被改掉的旧消息不再出现。分叉不再只限最后一条：任意已完成轮的助手回复都可以分叉，新会话走 Pi `createBranchedSession`，文件里只保留到该节点的路径。打开或冷订阅时 Registry 用同一份 jsonl 重放到 `PiToV4Projector`。不打开、不导入旧 PiCode event log。

## Model

主路径：`ModelRuntime.create()` 读 Pi 标准 `auth.json` / `models.json`，`createAgentSession` 不传 `model` 时走 settings 默认或第一个可用模型。壳上不再打开 PiCode WelcomeScreen/登录门禁。

SDK 来源是 `AppSettings.piSdkSource`。缺省 `builtin`，用打进 `zcode.cjs` 的 `@earendil-works/pi-coding-agent`。`global` 时 Host 注入 `ZCODE_PI_SDK=global`，进程里只解析一次本机 `npm root -g` 的同名包。主次版本必须和内置包一致，并且要有 `createAgentSession`。找不到、版本不一致或加载失败都继续用内置，原因记在 `runtime/capabilities` 的 `piSdk.reason`（`missing` / `incompatible` / `load-failed`）。改设置后重启应用再生效。委托测试用的 `createDelegateProvider` 仍走内置 `pi-ai`。

设置页的 HTTP 代理和「不使用代理的地址」仍写 `AppSettings`，由 Host 在拉起 agent 时注入 `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY`。CLI 仍会清掉进程里的标准 `HTTP_PROXY` / `NO_PROXY`，避免用户 shell 代理泄漏。清完之后只把这两个 ZCODE 值写回标准变量，并用已有的 `createNetworkProxyFetch` 换掉 `globalThis.fetch`。Pi 模型请求走这层 fetch；Pi bash 继承进程环境，curl/git 因此读到同一套规则。绕过规则与旧模型出口相同（主机、前缀点、端口、`*`）。没配代理则不换 fetch。改设置后下次启动 agent 生效。MCP 仍走原来的 `McpPort` 网络配置，不另开一条代理。

**目录所有者：** Pi `ModelRuntime.getAvailableSnapshot()`。CLI 在 `workspace/readPresentation` 上行目录；Host `IModelSelectionService` 只投影这份目录，不再用 PiCode Provider Registry 当聊天/设置页候选。投影必须把 `getView(input.selection)` 写成 `effectiveSelection`，否则 Composer 触发器拿不到当前草稿模型。Composer 与设置「模型设置」共用该视图。`switchModelConfig` 走 `session.setModel`。空闲时输入框里的模型属于下一次提交，在 `prompt` 或 steer 之前写入。会话已经在跑时，输入框一切模型或思考档位就立刻 `setModel`：已经发出的那次请求不中断，同一轮里的下一次模型请求用新的。排队项仍带着入队时的选择，出队再换。

设置页通过 `pi/models` 读写 `~/.pi/agent/models.json`（apiKey 明文回读，输入框不脱敏；保存时空字符串清掉密钥，请求不带 `apiKey` 则保留原值）和 `settings.json` 默认模型；保存后 `registerProvider`/`unregisterProvider` 更新活着的 `ModelRuntime`。渠道的 `api` 是默认请求格式。模型项没写 `api` 时补成渠道的；写成另一种驱动时保留，运行时用模型项上的 `api`。壳不另写 PiCode 供应商库。PiCode 账号登录、升级套餐、Coding Plan 额度不再作为产品面。

设置页「使用统计」只恢复应用用量。事实源是本机 Pi 会话 jsonl：`~/.pi/agent/sessions` 和旧的 `~/.PiCode/pi-host-sessions`，含子目录里的子会话。只读，不写回旧 usage 表。每个文件只计当前叶子；分叉抄来的同一条消息按 id 只计一次。时间窗外的消息不计。Pi 的 `input` 不含缓存，汇总时把 cache 加进 input，命中率才不会超过 1。没有首 token 耗时和工具耗时，这两项留空。

## Pi 插件开关

设置「插件」页只列 Pi 已配置的包和自动发现的扩展文件。列表来自 Pi `settings.json`（用户级 `~/.pi/agent/settings.json`，工作区级 `<cwd>/.pi/settings.json`），但开关不写回这两处。PiCode 的开关注 `~/.PiCode/pi-plugin-switches.json`，只在 PiCode 创建会话时叠加：关掉的包或扩展文件从这次会话的 extensions、skills、prompts 里拿掉；Pi 里关着、PiCode 里开着的，只在 PiCode 会话额外加载。Pi TUI 仍只看自己的 `autoload` 和 `extensions`。没在 PiCode 里动过的插件，跟随 Pi 当前状态。已打开的会话不热更新，下一次创建会话才生效。不再把 PiCode 插件市场当能力源。`plugins/*` 协议方法已删除，设置页不再列、安装或开关 PiCode 插件。

插件自己的设置不进 `settings.json`。能改的只有已经存在的 `~/.pi/agent/extensions/<名字>/config.json`。`list` 顺带这些文件里的顶层开关、数字和文本；`writeConfig` 只覆盖同名且同类型的顶层项，嵌套对象、数组和没出现过的键保持原样。不新建配置文件，也不执行插件代码去猜它的设置项。设置页不把这些表单铺在列表下面：能对上配置文件的插件，行内一个「设置」按钮，弹窗里改。改完同样从下一次新建会话生效。

技能设置读写 Pi 会加载的目录：用户 `~/.pi/agent/skills`，工作区 `<cwd>/.pi/skills`，仍列出 Pi 同样会读的 `.agents/skills`。斜杠菜单不另扫一套：已打开的会话用 Pi 已经加载的技能（含用户目录、沿 git 根的 `.agents/skills`、已启用的包技能）；没有会话时走 Pi 的包解析，不加载扩展。命令区只留 GUI 能用的：`/compact`、提示词命令，以及扩展注册的命令。扩展命令单独一组，不和原生命令混在一起。终端专属内置命令（`/copy`、`/new`、`/resume`、设置、模型选择、退出等）不展示，打出来也不发给模型。Pi 把技能注册成 `skill:` 命令；GUI 不收录，技能仍在原来的技能区。`/plan` 和 `/side` 仍是 GUI 自己的。命令设置读写 Pi 提示词目录：用户 `~/.pi/agent/prompts`，工作区 `<cwd>/.pi/prompts`。钩子不进入 Pi 会话，设置页不再单独列出。

内置浏览器是宿主能力，不是可安装插件。会话创建时直接连上打包好的 `node_repl`，并把 `control-browser` 技能交给 Pi。工具名仍是 `mcp__node_repl__js`。direct 调用带上当前会话 id，browser broker 才能回到 `BrowserControlPort`，再调 Electron `interaction/browserExecute`。不写进用户 MCP 配置。开关在 `~/.PiCode/v2/setting.json` 的 `browserHostEnabled`，缺省开启，只影响之后新建的会话。子会话不带这个工具。

SSH 工作区不部署远端 zcode-server，也不从 PiCode CDN 下载或上传运行时。状态所有者仍是本机 Pi：模型读本机 `~/.pi/agent`，会话 jsonl 写在本机。窗口 Host 只记住该 workspace identity 对应的 SSH 目标（别名优先，否则 `user@host` 加端口），并在拉起本机 agent 时放进 `ZCODE_SSH_REMOTE`。这个进程里的 read / write / edit / bash / ls / grep / find 经系统 `ssh` 作用在远端路径上。Pi 在 Windows 上会把远端路径 resolve 成盘符路径；会话提示改回远端 posix 路径，命令里的盘符前缀在执行前换回去。bash 的 timeout 按秒计。会话 jsonl 按 workspace identity 分目录，侧栏才能列出来；目录选择的默认路径是远端 `/home`。密码和私钥不进环境变量；认证失败就失败，不回退到远端安装。WSL 和 Docker 仍走原来的远端 server。

编辑供应商是两步弹窗：第一步写名称、ID、端点、密钥和渠道 `api`；第二步是单列模型卡片，可从端点拉取或手填模型 ID。状态所有者仍是 `models.json`，不另建一套绑定表。已有供应商的 ID 不可改。

|界面|落盘（Pi `models.json` 模型项）|
|---|---|
|别名|`name`|
|API 格式|跟随渠道则写成渠道 `api`；选了别的驱动则写模型项 `api`|
|上下文窗口|`contextWindow`|
|最大输出|`maxTokens`|
|图片输入|`input` 含 `image`|
|启用的思考等级|`thinkingLevelMap` 的 key；已有 value（含自定义 mapping）保留|
|默认思考等级|向导不编辑。文件里已有的 `defaultThinkingLevel` 原样保留；`ModelRuntime` 不消费|

测试连接复用 `discover`（`GET {baseUrl}/models`），不走旧 PiCode `testModelConnectivity`。不做拖拽排序、思考格式、自定义 Headers、超时、子智能体可用、PDF 能力——这些不进设置页。`compat` 等文件里已有的字段保存时原样留下。

测试可仍传 `stream`/`delegate` 走隔离 `InMemoryCredentialStore` + `zcode-delegate`，不碰磅真实 Pi 凭证。

## Pi 进程

长驻命令的主人是 Pi 插件 `pi-processes`，不是旧的后台 bash。加载扩展的会话会挂一个隐藏 inline extension，只听 `processes:changed`，把仍在跑的进程写成 `backgroundWorks`：`kind` 仍是 `bash`，`workId` 前缀是 `pi-process:`。状态面板里已有的「终端」列表、日志侧栏和停止按钮因此能用，不必再打 `/ps` 或 `/ps:kill`。

停止这个前缀只发插件的 `processes:command:kill`，不调用 `session.abort()`。日志走原来的 `readBackgroundBashOutput`，读插件的合并输出；侧栏仍按一秒轮询，跑着就继续读。进程结束就离开列表，不写入会话 jsonl。

`/ps` 和 `ps:` 开头的命令是 Pi TUI 的。GUI 不展示，打出来也不发给模型。模型继续用插件的 `process` 工具。没装这个插件时列表为空，停止和读日志都当不存在。SSH 工作区里插件起的是本机进程，不是远端 shell；远端命令仍走现有的 ssh bash。

## 明确不做

- 用 customTools 包装 PiCode 旧工具 handler。子代理和 MCP 例外：这两项由 PiCode 持有定义，Pi 只负责调用
- 渲染进程跑 `pi-tui`
- `pi --mode rpc` 子进程当内核
- 为手机另起 Pi
- 终端 TUI
- 专项插件 renderer（名单后补）
- `AskUserQuestion` 与设置项「提问自动继续」。当前会话不注册这个工具，也不再按 5 分钟自动结束提问。权限确认和计划审批仍走原来的交互。
