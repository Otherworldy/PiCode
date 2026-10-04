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
  → idle startNow → session.prompt（图片读成本地文件，跟文字一起交给 Pi）
    正在跑的 turn + guide → session.steer（同样带图片）
    正在跑、或压缩中 → HostQueue.enqueue（只存路径）；压缩结束且不再 streaming 时 drain
    入队、删除、改写、排序 → replaceQueue 把当前文本推给界面。没推出去就看不到，也取消不了
  → Pi 事件
  → Projector 写 ConversationDelta
  → ConversationTopicPublisher.ingestDeltas
  → desktop-continuous 30ms / web-remote-replayable 150ms
```

同一所有者，两套 flush。jsonl 为对话树真相；V4 snapshot 为 UI/远控派生缓存，可从 jsonl 重建。打开时若 publisher 还没有行，订阅前用 jsonl 再画一次；否则会交出空快照，加载结束后只剩输入框。runtime `dispose` 后从注册表摘掉，不删 jsonl；留着已关掉的实例会让下次打开直接复用它，冷恢复不再读文件，画面仍是空的。

上下文环的总量来自 Pi `getContextUsage()`，不另算。`message_end`、`tool_execution_end`、`compaction_end`，以及非重试的 `agent_end` 立刻推。流式 `message_update` 最多 250ms 推一次，生成过程中按 Pi 的估算上涨，不等整轮结束。值和上次一样则不下发。

分类和 pi-cc `/context` 同一口径，不新做扩展：System prompt、Memory（系统提示里的 `project_instructions`）、Skills、Tools definition、Tool results、Context。字符数除以 4 估算；System / Memory / Skills / Tools 保持原值，后两项缩放到总量。对不上的差额是 Other。`breakdown[].chars` 与 `tokens` 都写缩放后的 token，弹层用这个数。供应商用量比内容估算小一个数量级时，总量改用估算。

## 失败语义

- Pi 拒 prompt（preflight false）：ACK 失败，不造假 turn。rewind 之后、重发完成之前的任何失败，都用 jsonl 把原对话行画回去。
- `getModel()` 返回 `provider/model`。旧 snapshot 把裸模型 id 当成非法选择，会在截断之后把编辑打失败。
- 新建会话的 Pi 投影增量写入 sessions-index。只跳过纯文本流式 delta。第一条用户消息同时成为侧栏标题。
- 打开中的会话，侧栏转圈以该 pane 的 conversation snapshot `control.phase` 为准。sessions-index 还停在上一轮 completed 时，正在跑的这一行仍要转。未读点只在没有这份实时 phase 时盖过转圈。
- 流中途失败：turn `failed`，已写出的 row 保留。
- 模型失败只把一句摘要写进回复和 `lastError.message`；原始 JSON 放 `lastError.detail`。
- Pi `auto_retry_start` 写入 `control.apiRetry.failures`。最终失败只进输入框上方的原错误横幅，摘要一行，历次失败和原文在「展开详情」。不写成助手正文。成功后清掉重试状态。同一次失败的后续 `agent_settled` 不清掉这条错误。
- `/compact` 直接调用 Pi `session.compact()`，不进入输入队列。Pi 会先中断当前操作再压缩。空闲时压缩也要打开停止：`canStop` 为真，Stop 中断这次摘要请求。跑着的轮次里发生的自动压缩不抢走该轮的停止权。完成后的摘要写在 compact marker 的 `summary` 上，界面可展开查看。这条分隔线不进「已工作」折叠：轮次收起后仍要看见「正在压缩上下文」和终态。失败原因写在 marker 的 `error` 上，并进入输入框上方的错误横幅。命令被拒绝时也要弹出原因，不能只写日志。重开会话时从 jsonl 的 compaction 条目还原同一条 marker。
- 输入框模型左侧的圆环读 Pi `getContextUsage()`。一轮结束、压缩结束或切换模型后写入 `usage.contextWindow`。点击圆环发送 `/compact`。
- 打开会话只下发尾部一窗。页面向上滚动再拉更早的一窗，不再在打开时把整段历史灌进时间线。下发的工具参数和输出只留 head+tail；宿主里的原文仍留给文件回滚。投影未到时时间线显示加载，不留白。
- 冷恢复重放 jsonl 时，行先落完，actions 只算一次。不能每条事件都扫整窗，否则几万行的会话订阅一直不返回。
- 折叠的工具历史不挂载，时间线只保留视口附近的轮次。截断轮自动补齐最多 3 窗，其余靠上滚再拉。
- abort：turn `completedInterrupted`，运行中工具 `cancelled`。用户已经停止后，重试再发的 `agent_start` / `auto_retry_start` 不能把这次停止清掉，要再 abort。Stop 同时拆掉还在飞的代理请求，避免重试里的 CONNECT 不看 abort 信号。
- `custom()` 无 adapter：降级 widget 文本，不卡循环。
- 插件抛错：`extension_error` → notify，会话继续。
- 本地会话不把 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` / `powershell` 注册成 customTools，也不关 Pi 内置工具。Pi 默认只激活 `read` / `bash` / `edit` / `write`；Host 在本地会话里补上已注册的 `grep` / `find` / `ls`。扩展仍可按原名替换，例如 pi-fff。卸掉替换扩展后，内置实现还在。权限走 `tool_call`，不换工具实现。SSH 工作区仍用远端实现替换 `read` / `bash` / `edit` / `write`，不把本机的 `grep` / `find` / `ls` 打开，否则这些工具打到本机盘。
- PiCode 不再注册 `TodoRead` / `TodoWrite`，也不再提醒模型去调用它们。旧会话里的 todo 卡片和进程投影仍按工具名渲染。
- 桌面和 CLI 同一份 `zcode.cjs` 把 Pi 打进 CJS。入口先设 `globalThis.PI_BUNDLED_NODE`，Pi 才用内嵌模块表加载 extension，而不是按 bundle 路径去找 `../dist/babel.cjs`。`import.meta.url` 不能改写成 `module.filename`：extension loader 同一个函数里有 `const module`，那个标识符在死区里，extension 会在 import 之前就失败。文件名改记在 `globalThis.__zcodeBundleFilename`。
- 插件后台任务打到已失效的 extension ctx 时，app-server 只记一行并继续。这个拒绝不能把进程打退出。
- 插件直接 `createAgentSession` 绕过 Registry：扁 `toolCall`，无 `workId`，无活动面板。

## V4 命令

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`continueAfterError`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`、`applyFileRewind`、`readSessionTree`、`navigateSessionTree`、`labelSessionEntry`。

消息上不再提供 `forkAssistant`。从此处继续走 `navigateSessionTree`，结果是左侧列表里的新会话，不是同一份 jsonl 里换叶子。标题旁不再切分支。

`navigateSessionTree` 先按当前叶子 `createBranchedSession` 复制出新文件，再只在新会话上走 Pi `navigateTree`。原会话叶子不动。不总结、总结、自定义提示词仍传给这次导航。助手节点停在该条；用户节点回到父节点，原文只在新会话输入框为空时写回，不自动发送。成功后回执带新 `sessionId`，界面切过去，并立刻把新会话补进当前 sessions-index，不等重启重扫 jsonl。新会话沿用原会话的协作模式和已允许的工具：完全访问不再重新弹权限。总结成功后在新文件追加 `branch_summary`。导航后按内存里的 `getLeafId()` / `buildContextEntries()` 重放。不带 `label`。入口是消息上的右键。用户、助手和工具行都可以。工具行带的是 `toolCallId`。右键菜单或自定义提示词对话框开着时，这条消息用选中底色标出。压缩进行中拒绝。正在生成不打断原会话。总结进行中 Stop 打到原会话，转给新会话的 `abortBranchSummary()`，不切过去，新文件删掉。不回滚工作区文件。`editUserQuery` 仍走原来的 `navigateTree` 裁切，不进这条命令。

`readSessionTree` 把 `getTree()` 压成平铺节点，放在命令回执里，不进每条快照。压平用循环：一条几万层的父链用递归，打开会话时会栈溢出。`labelSessionEntry` 写 Pi 的 label，再回一份树。

`sendText` 的图片仍读成字节交给 Pi。其它附件不再在进模型前丢掉：文本文件把路径和最多 64KiB 正文附在 prompt 后面，PDF、视频和二进制只附路径。这段用 `<zcode-file>` 包住，用户气泡只留原文和附件芯片。

模型请求失败后，输入框上方的错误横幅有重试。`continueAfterError` 不重发用户原文，也不截断会话：去掉最后一条 `stopReason: error` 的助手消息，再 `agent.continue()`，从失败前的用户或工具结果接着跑。还在生成时拒绝。

`deleteSessionBranch` 删掉侧枝上当前路径用不到的条目并重写 jsonl；当前分支、生成中、压缩中都拒绝。当前路径不变，不重建模型上下文，也不重放对话。

删除（协议 + UI）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、`resumeWorkflowRun`、`startSavedWorkflow`、`amendWorkflowRunSettings`、workspace hook 审核三件套、`switchCollaborationMode`、`discardSharedContext`。

`editUserQuery` 重发用这次输入框里的模型。命令带了 `modelSelection` 就用它，不再套该轮最初的模型；没带时仍用原轮选择。

`applyFileRewind` 只退这一轮的文件，不截断聊天。真相是这一轮成功的 Pi 工具参数，不是旧 checkpoint。`edit` 要当前文件仍能唯一匹配 `newText` 才写回 `oldText`。`write` 要当前内容仍等于写入内容才删除该文件；覆盖掉的旧内容找不回来。对不上就整批不写。`bash` 只记为忽略，不阻止文件摘要上的撤销；编辑消息并选了回滚文件时，有忽略项仍拒绝。成功后把该轮 `fileChanges.state` 改成 `reverted`。SSH 工作区走和工具同一条远端读写。

`switchCollaborationMode` 不恢复为 PiCode 协作模式机。危险工具仍走 PiCode `PermissionService`（Pi 无权限面）：allow 放行、deny 拒绝、ask 投影 `kind: permission` 给壳 PermissionDialog（Allow once / Allow for session / Block）。session allow 由 HostedSession 记忆。`mode=yolo` 直接放行全部工具，不再弹权限窗。输入框切换权限立刻写到这个会话，不等下一条消息。切到完全访问时，正在等的工具权限按允许关掉。插件 `confirm` 视为同意。`select` / `input` / `editor` 仍进底栏等人答，完全访问也不代答。`select` 把 `1. 标签 — 说明` 拆成问卷选项，回答仍回传原行。其它模式的 `confirm/select` 同样走底栏 userInput，不用 viewport overlay。

## 死面

壳上拆掉：PluginStore、SavedWorkflows、Automations/OffPeak、CUA、Goal、PiCode 子代理 profile、官方 plugin 商店。设置改为已加载 Pi extensions 列表。插件页用 Pi `PackageManager.checkForAvailableUpdates` / `update` 检查并更新 npm、git 包。本地 extension 文件和钉死版本不更新。装完后下次新建会话生效。

壳上新增：输入框 Extension Widget 槽。非计划插件的 status 收成输入框上方一个 popup，不再平铺 chips。

宿主 UI 带上纯文本 `theme`（`fg` / `bg` / `bold` / `italic` / `underline` / `inverse` / `strikethrough` 原样返回文字，不发 ANSI）。缺 `theme` 时 Plannotator 在 `ctx.ui.theme.fg` 上抛错：批准计划后的 `plannotator_submit_plan` 和 `plannotator_mark_done` 都失败，`plannotator-progress` 清单也写不出去。清单仍由插件 `setWidget` 持有，输入框下不平铺这份原文。没有 TodoWrite 的 `plan` 时，状态面板的原 Todo 段用这份 widget 列出进度，不另写一份 plan。

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

仍在跑的子会话打开侧栏时，jsonl 重放不把最后一轮收成完成。轮次保持 `running`，工时用消息时间戳，不用重放当时的墙钟。侧栏因此显示「工作中」并展开工具，而不是「已工作 1 秒」。文件在子会话结束前按秒重读；结束后再按完整轮次收口。已结束的历史文件仍按消息时间戳计工时。

正在跑的 `picode_subagent` 只活在当前进程里。父会话把这些活会话写进 `backgroundWorks`（`kind: subagent`，`workId` 和 `childSessionId` 都是子会话 id，`cancellable: true`），状态面板因此出现停止按钮。`cancelBackgroundWork` 只 abort 这个子会话，不停父会话。按下停止后这一行立刻离开「正在运行」，即使 jsonl 还没写成终态。磁盘上看起来还在跑、但本进程已经没有的记录不给按钮。

活着的子会话把当前 `provider` / `model` / `thought` 放进 `subagents.running`。状态面板用这份值和会话已有的模型目录展示下拉框。`setRunningSubagentModel` 只调用这个子会话的 `setModel` / `setThinkingLevel`，不改父会话，也不写设置里的默认。已经发出的请求不打断，下一次模型请求用新的。本进程没有的运行记录只显示目录，不能改。

设置页拥有代理定义：用户 `~/.PiCode/agents`，项目 `<workspace>/.PiCode/agents`，内置 `general-purpose` / `Explore`。Pi 会话挂一个 `picode_subagent` 工具，按这份定义起子会话。子会话不再挂这个工具，也不挂 MCP。同名的 Pi 插件工具 `subagent` 在主会话上禁用，避免两套定义争用。

## MCP

设置页写入的 MCP（`~/.PiCode/cli/config.json` 的 `mcp.servers`）由 PiCode 的 `McpPort` 调用，不读 Pi 自己的 MCP 配置。默认只注册一个 `mcp` 代理工具：先列服务器，再按服务器搜索或描述工具，最后 `tool` + `args` 调用。服务器在第一次被代理用到时才连接。某个 server 设 `directTools: true` 时，才在会话创建时连接并把它的工具逐个注册成 Pi 工具。`enabled: false` 不连接。连接失败只记一条警告，不阻止会话创建。

## 持久化与旧会话

对话树真相是 Pi jsonl，与 Pi TUI 共用 `~/.pi/agent/sessions/<encoded-cwd>/`（文件名 `timestamp_<id>.jsonl`，header id 为 sessionId）。新建/fork 写这里，不预建空文件（Pi 在首条 assistant 落盘）。仍枚举旧 `~/.PiCode/pi-host-sessions/<identity>/` 以免丢本 Host 已写过的会话；文件名是 `timestamp_<id>.jsonl` 时列表 id 用 header，不用整段文件名。列表时间用会话 header 和最后一条用户/助手消息；分叉抄来的旧消息、以及打开时写入的 label，都不能改这个时间。sessions-index 只列出有过用户消息（或 `session_info.name`）的文件。删除会话时关掉活着的 runtime，并删掉该 id 在本机目录和旧 hosted 目录里的 jsonl；列表行随后消失，不留可恢复的副本。壳项目列表以这份摘要为行集合，tasks-index 只提供 pin/archive/unread。重开只画当前叶子到根的那条分支，文件里被改掉的旧消息不再出现。分叉不再只限最后一条：任意已完成轮的助手回复都可以分叉，新会话走 Pi `createBranchedSession`，文件里只保留到该节点的路径。打开或冷订阅时 Registry 用同一份 jsonl 重放到 `PiToV4Projector`。不打开、不导入旧 PiCode event log。

## Model

主路径：`ModelRuntime.create()` 读 Pi 标准 `auth.json` / `models.json`，`createAgentSession` 不传 `model` 时走 settings 默认或第一个可用模型。壳上不再打开 PiCode WelcomeScreen/登录门禁。

SDK 来源是 `AppSettings.piSdkSource`。缺省 `builtin`，用打进 `zcode.cjs` 的 `@earendil-works/pi-coding-agent`。`global` 时 Host 注入 `ZCODE_PI_SDK=global`，进程里只解析一次本机 `npm root -g` 的同名包。主次版本必须和内置包一致，并且要有 `createAgentSession`。找不到、版本不一致或加载失败都继续用内置，原因记在 `runtime/capabilities` 的 `piSdk.reason`（`missing` / `incompatible` / `load-failed`）。改设置后重启应用再生效。委托测试用的 `createDelegateProvider` 仍走内置 `pi-ai`。

设置页的 HTTP 代理和「不使用代理的地址」仍写 `AppSettings`，由 Host 在拉起 agent 时注入 `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY`。CLI 仍会清掉进程里的标准 `HTTP_PROXY` / `NO_PROXY`，避免用户 shell 代理泄漏。清完之后只把这两个 ZCODE 值写回标准变量，并用已有的 `createNetworkProxyFetch` 换掉 `globalThis.fetch`。Pi 模型请求走这层 fetch；Pi bash 继承进程环境，curl/git 因此读到同一套规则。绕过规则与旧模型出口相同（主机、前缀点、端口、`*`）。没配代理则不换 fetch。改设置后下次启动 agent 生效。MCP 仍走原来的 `McpPort` 网络配置，不另开一条代理。

**目录所有者：** Pi `ModelRuntime.getAvailableSnapshot()`。CLI 在 `workspace/readPresentation` 上行目录；Host `IModelSelectionService` 只投影这份目录，不再用 PiCode Provider Registry 当聊天/设置页候选。投影必须把 `getView(input.selection)` 写成 `effectiveSelection`，否则 Composer 触发器拿不到当前草稿模型。Composer 与设置「模型设置」共用该视图。`switchModelConfig` 走 `session.setModel`。空闲时输入框里的模型属于下一次提交，在 `prompt`、steer 或手动 `/compact` 之前写入。压缩不读会话里的旧模型。会话已经在跑时，输入框一切模型或思考档位就立刻 `setModel`：已经发出的那次请求不中断，同一轮里的下一次模型请求用新的。排队项仍带着入队时的选择，出队再换。

设置页通过 `pi/models` 读写 `~/.pi/agent/models.json`（apiKey 明文回读，输入框不脱敏；保存时空字符串清掉密钥，请求不带 `apiKey` 则保留原值）和 `settings.json` 默认模型；保存后 `registerProvider`/`unregisterProvider` 更新活着的 `ModelRuntime`。渠道的 `api` 是默认请求格式。模型项没写 `api` 时补成渠道的；写成另一种驱动时保留，运行时用模型项上的 `api`。壳不另写 PiCode 供应商库。PiCode 账号登录、升级套餐、Coding Plan 额度不再作为产品面。

设置页「使用统计」只恢复应用用量。事实源是本机 Pi 会话 jsonl：`~/.pi/agent/sessions` 和旧的 `~/.PiCode/pi-host-sessions`，含子目录里的子会话。只读，不写回旧 usage 表。每个文件只计当前叶子；分叉抄来的同一条消息按 id 只计一次。时间窗外的消息不计。Pi 的 `input` 不含缓存，汇总时把 cache 加进 input，命中率才不会超过 1。没有首 token 耗时和工具耗时，这两项留空。

## Pi 插件开关

设置「插件」页只列 Pi 已配置的包和自动发现的扩展文件。列表来自 Pi `settings.json`（用户级 `~/.pi/agent/settings.json`，工作区级 `<cwd>/.pi/settings.json`），但开关不写回这两处。PiCode 的开关注 `~/.PiCode/pi-plugin-switches.json`，只在 PiCode 创建会话时叠加：关掉的包或扩展文件从这次会话的 extensions、skills、prompts 里拿掉；Pi 里关着、PiCode 里开着的，只在 PiCode 会话额外加载。Pi TUI 仍只看自己的 `autoload` 和 `extensions`。没在 PiCode 里动过的插件，跟随 Pi 当前状态。已打开的会话不热更新，下一次创建会话才生效。不再把 PiCode 插件市场当能力源。`plugins/*` 协议方法已删除，设置页不再列、安装或开关 PiCode 插件。

插件自己的设置不进 `settings.json`。能改的只有已经存在的 `~/.pi/agent/extensions/<名字>/config.json`。`list` 顺带这些文件里的顶层开关、数字和文本；`writeConfig` 只覆盖同名且同类型的顶层项，嵌套对象、数组和没出现过的键保持原样。不新建配置文件，也不执行插件代码去猜它的设置项。设置页不把这些表单铺在列表下面：能对上配置文件的插件，行内一个「设置」按钮，弹窗里改。改完同样从下一次新建会话生效。

技能设置读写 Pi 会加载的目录：用户 `~/.pi/agent/skills`，工作区 `<cwd>/.pi/skills`，仍列出 Pi 同样会读的 `.agents/skills`。斜杠菜单不另扫一套：已打开的会话用 Pi 已经加载的技能（含用户目录、沿 git 根的 `.agents/skills`、已启用的包技能）；没有会话时走 Pi 的包解析，不加载扩展。命令区只留 GUI 能用的：`/compact`、提示词命令，以及扩展注册的命令。扩展命令单独一组，不和原生命令混在一起。终端专属内置命令（`/copy`、`/new`、`/resume`、设置、模型选择、退出等）不展示，打出来也不发给模型。Pi 把技能注册成 `skill:` 命令；GUI 不收录，技能仍在原来的技能区。`/side` 仍是 GUI 自己的。计划模式只跟已启用的 `@plannotator/pi-extension`。没装或没启用时，输入框不显示计划开关，`/plan` 直接拒绝。新建任务里的开关和空 `/plan` 只记在草稿上，不创建会话。真正发出第一条消息时才先发送 `/plannotator-plan-mode`。这条命令和其他单独的斜杠命令不当会话标题，标题仍取之后第一条真正的用户消息。会话库 `first_input` 和任务索引同样不保留这条命令；列表摘要里已经有真实标题时直接换上，不必先点开会话。已有会话的开关直接发送该命令。带正文的 `/plan` 先进入计划模式，再把正文发给模型。PiCode 自己的 `planEnabled` 不再发给 Host。命令设置读写 Pi 提示词目录：用户 `~/.pi/agent/prompts`，工作区 `<cwd>/.pi/prompts`。钩子不进入 Pi 会话，设置页不再单独列出。

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
