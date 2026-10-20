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

常驻池只卸真正空闲的会话。投影 `phase` 已经离开 `running`，但 Pi 仍在 streaming、压缩或重试（`isStreaming` / `isCompacting` / `isIdle === false`），或队列、后台任务、子会话、分支总结、未决交互还在，都不算空闲。只看 `phase === "running"` 会在超过高水位或空闲超时后把还在跑的 runtime 拆掉，内存里的对话投影一起没了。再点开要冷恢复，界面停在「正在加载会话」。事实归 `HostedSession.hasResidencyBlockingWork`，常驻池只读这一个布尔。

冷打开（注册表里还没有这个会话，真正走了 `openFile`）打一行 `pi_host.conversation.open_timing`。已经在注册表里的再次 `create` 不打。打开失败也不打。三段互不包含：

- `readJsonlMs`：冷恢复那一次 `find`，加上把目标 jsonl 读成字符串和 `readPiJsonl` 解析。不含投影重放，也不含 Pi `SessionManager.open` 自己读文件。`find` 先按文件名（`sessionId.jsonl` 或 `*_<sessionId>.jsonl`）命中，对不上再只读首行 session header；不再为了比对 id 把其它会话整份读进来。找到的路径传给 `create`，不再扫第二遍。
- `createPiSessionMs`：`createSession`（含 Pi `createAgentSession`）。
- `replayMs`：只包 `projector.replay`。

这行只用来看打开慢在哪一段，不改投影、订阅或常驻。首帧渲染在 renderer，见 `packages/ui/src/v4/SPEC.md`。

卸掉 runtime 时先发 `session_shutdown`，再调 `AgentSession.dispose()`。Pi 的 MCP 扩展只在 `session_shutdown` 里关掉 stdio 子进程；`dispose()` 本身不发这个事件。不先发的话，常驻回收之后 `node_repl` 和 `chrome-devtools-mcp` 仍挂在 app-server 下面。同一次关闭只跑一遍，后来的 `dispose()` 等同一个 Promise。注册表在这次关闭开始时同步摘掉，不等子进程退出。

`chrome-devtools-mcp` 不在 `session_start` 时连接。命令行里带这个包、且工具不是 `direct` 的 stdio 服务器从启动配置里拿掉，只在 codemode / `tool_search` 点名它时才 `registerMcpServer`。全局 `searchTools()` 不会把它拉起来。`node_repl` 和其他 MCP 仍按原来的时机连接。会话结束时，这次迟到的注册走同一条 `session_shutdown` 关闭。

上下文环的已用量来自 Pi `getContextUsage()`，不另算。`message_end`、`tool_execution_end`、`compaction_end`，以及非重试的 `agent_end` 立刻推。流式 `message_update` 最多 250ms 推一次，生成过程中按 Pi 的估算上涨，不等整轮结束。值和上次一样则不下发。总量是当前会话模型的 `contextWindow`。模型只在下一次提交时写入会话，所以切换后、发送前不能等这份快照：目录里已有所选模型的 `contextWindow` 时，圆环总量改读这个字段（与 Pi `Model.contextWindow` 同一值）。目录还没有时仍用快照。

分类和 pi-cc `/context` 同一口径，不新做扩展：System prompt、Memory（系统提示里的 `project_instructions`）、Skills、Tools definition、Tool results、Context。字符数除以 4 估算；System / Memory / Skills / Tools 保持原值，后两项缩放到总量。对不上的差额是 Other。`breakdown[].chars` 与 `tokens` 都写缩放后的 token，弹层用这个数。供应商用量比内容估算小一个数量级时，总量改用估算。

## 失败语义

- Pi 拒 prompt（preflight false）：ACK 失败，不造假 turn。rewind 之后、重发完成之前的任何失败，都用 jsonl 把原对话行画回去。
- `getModel()` 返回 `provider/model`。旧 snapshot 把裸模型 id 当成非法选择，会在截断之后把编辑打失败。
- 新建会话的 Pi 投影增量写入 sessions-index。只跳过纯文本流式 delta。第一条用户消息先成为侧栏标题。这条真实用户消息一落地就排上标题总结，不等整轮结束：首轮被中断后仍要能总结，否则标题会一直停在原文。会话自己的模型请求优先。助手回复开始之前不发总结请求，避免总结抢先占住模型，页面停在标题上。会话请求已经发出后，总结与这一轮并行，不取消、也不等 `agent_end`。总结返回后立刻更新侧栏标题。`session_info` 会把 jsonl 叶子换掉，流式中途不写；等这轮不再占用叶子时再落盘。还没有助手回复就结束的轮次，在 `agent_end` 放行总结。重放出来的 `agent_settled` 不触发。若总结开着、标题不是用户手改的、且 jsonl 还没有 `session_info` 名字，就用总结模型换成短标题并写入 `session_info`。没配总结模型就用这一轮的对话模型。当时已经有的助手回复会一并送进去，但不等回复写完。失败或关闭时保留截断标题。同一会话只自动总结一次。子会话不总结。用户重命名同样写入 `session_info`，之后自动标题不再覆盖。重放 jsonl 不发首条原文这一帧临时标题；文件里还没有 `session_info` 名字时，也不能把已经写上的总结标题盖回原文。侧栏「总结标题」是另一次显式请求：不受自动开关和手改保护限制，读当前会话或 jsonl 后返回标题，由壳按重命名写入。
- 打开中的会话，侧栏转圈以该 pane 的 conversation snapshot `control.phase` 为准。sessions-index 还停在上一轮 completed 时，正在跑的这一行仍要转。未读点只在没有这份实时 phase 时盖过转圈。
- 询问答完或对应工具进入 success/error/cancelled 后，侧栏「等待确认」必须消失。活的 `tool_execution_end` 在同一批 delta 里拿掉这份 `pendingInteractions`；冷恢复重放不清当前未决交互。侧栏只认仍在阻塞的交互：工具行已经终态的不再显示。乐观列表合并不能把旧的 `pendingInteraction` 盖回 sessions-index 行。
- 流中途失败：turn `failed`，已写出的 row 保留。
- 模型失败只把一句摘要写进回复和 `lastError.message`；原始 JSON 放 `lastError.detail`。
- Pi `auto_retry_start` 写入 `control.apiRetry.failures`。最终失败只进输入框上方的原错误横幅，摘要一行，历次失败和原文在「展开详情」。不写成助手正文。成功后清掉重试状态。同一次失败的后续 `agent_settled` 不清掉这条错误。
- `/compact` 直接调用 Pi `session.compact()`，不进入输入队列。Pi 会先中断当前操作再压缩。空闲时压缩也要打开停止：`canStop` 为真，Stop 中断这次摘要请求。跑着的轮次里发生的自动压缩不抢走该轮的停止权。完成后的摘要写在 compact marker 的 `summary` 上，界面可展开查看。这条分隔线不进「已工作」折叠：轮次收起后仍要看见「正在压缩上下文」和终态。失败原因写在 marker 的 `error` 上，并进入输入框上方的错误横幅。命令被拒绝时也要弹出原因，不能只写日志。重开会话时从 jsonl 的 compaction 条目还原同一条 marker。
- 输入框模型左侧的圆环，已用量读 Pi `getContextUsage()`。一轮结束、压缩结束或会话模型写入后写入 `usage.contextWindow`。切换模型不改会话，只改下一次提交；圆环总量必须马上跟着 Composer 已选模型的目录 `contextWindow`，不能停在默认模型直到发出下一条消息。点击圆环发送 `/compact`。
- 打开会话只下发尾部一窗。页面向上滚动再拉更早的一窗，不再在打开时把整段历史灌进时间线。下发的工具参数和输出只留 head+tail；宿主里的原文仍留给文件回滚。投影未到时时间线显示加载，不留白。
- 冷恢复重放 jsonl 时，行先落完，actions 只算一次。不能每条事件都扫整窗，否则几万行的会话订阅一直不返回。
- 折叠的工具历史不挂载，时间线只保留视口附近的轮次。截断轮自动补齐最多 3 窗，其余靠上滚再拉。
- abort：turn `completedInterrupted`，运行中工具 `cancelled`。用户已经停止后，重试再发的 `agent_start` / `auto_retry_start` 不能把这次停止清掉，要再 abort。Stop 同时拆掉还在飞的代理请求，避免重试里的 CONNECT 不看 abort 信号。
- 上一轮还在跑时再发消息：进 HostQueue（guide 则 steer），不调用 `session.prompt`。投影 phase 已经不是 running、但 Pi 仍在 streaming 时也一样。Pi 对裸 prompt 抛 `already processing`；这个 rejection 没人接会把 agent 进程打退出，会话直接结束。编辑重发和插件仍可能在 `isStreaming` 还是 false 的窗口里撞上正在跑的那一轮：这种 rejection 改成 followUp，当前轮继续，不能退出进程。进程错误边界也不把这条当成致命错误。drain 失败只记日志，并把取出的队列项放回队首。
- `custom()` 无 adapter：降级 widget 文本，不卡循环。
- 插件抛错：`extension_error` → notify，会话继续。
- 本地会话不把 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` / `powershell` 注册成 customTools，也不关 Pi 内置工具。Pi 默认只激活 `read` / `bash` / `edit` / `write`；Host 在本地会话里补上已注册的 `grep` / `find` / `ls`。扩展仍可按原名替换，例如 pi-fff。卸掉替换扩展后，内置实现还在。权限走 `tool_call`，不换工具实现。SSH 工作区仍用远端实现替换 `read` / `bash` / `edit` / `write`，不把本机的 `grep` / `find` / `ls` 打开，否则这些工具打到本机盘。
- PiCode 不再注册 `TodoRead` / `TodoWrite`，也不再提醒模型去调用它们。消息流不再渲染这些历史工具卡。快照里的 plan 仍给状态面板；没有 plan 时，状态面板用 `plannotator-progress`。
- 桌面和 CLI 同一份 `zcode.cjs` 把 Pi 打进 CJS。入口先设 `globalThis.PI_BUNDLED_NODE`，Pi 才用内嵌模块表加载 extension，而不是按 bundle 路径去找 `../dist/babel.cjs`。`import.meta.url` 不能改写成 `module.filename`：extension loader 同一个函数里有 `const module`，那个标识符在死区里，extension 会在 import 之前就失败。文件名改记在 `globalThis.__zcodeBundleFilename`。
- 同一个标志让 codemode 去 bundle 旁边找 `codemode-worker.js` 和 `quickjs.wasm`。wasm 不能放进 `glm/node_modules`：electron-builder 复制 extraResources 时会丢掉源目录根上的 `node_modules`，安装包里沙箱会报找不到模块。bundle 启动时把 `quickjs-wasi/quickjs.wasm` 指到旁边这个文件。wasm 取 Pi 依赖的 `quickjs-wasi@3.6.2`；仓库里被 hoist 的 2.2.0 没有这个导出。没标成 `direct` 的 MCP（包括 tdx）只能从这个沙箱里调。
- Pi 缩放内联图片读同目录的 `photon_rs_bg.wasm`（`@silvia-odwyer/photon-node`，与 Pi 依赖锁定的版本一致）。缺这个文件时缩放返回空，任意图片都会被换成 `[Image omitted: could not be resized below the inline image size limit.]`。不能放进 `glm/node_modules`，原因同上。
- 插件后台任务打到已失效的 extension ctx 时，app-server 只记一行并继续。这个拒绝不能把进程打退出。
- 插件直接 `createAgentSession` 绕过 Registry：扁 `toolCall`，无 `workId`，无活动面板。

## V4 命令

保留：`createSession`、`createSelectionSideSession`、`sendText`、`stop`、`continueAfterError`、`compact`、`forkAssistant`、`editUserQuery`、`retryTurn`、队列五件套、`setFollowupMode`、`switchModelConfig`、`resolveInteraction`、`snoozeInteractionAutoResolution`、`cancelBackgroundWork`、`renameSession`、`deleteSession`、`setAssistantFeedback`、`applyFileRewind`、`readSessionTree`、`navigateSessionTree`、`labelSessionEntry`。

助手行底栏仍可一键 `forkAssistant`。行右侧分叉按钮里的「从这分叉」走同一条命令，只在这条助手消息可以分叉时出现。从此处继续（不总结、总结、自定义提示词）走 `navigateSessionTree`，结果是左侧列表里的新会话，不是同一份 jsonl 里换叶子。标题旁不再切分支。

`navigateSessionTree` 先按当前叶子 `createBranchedSession` 复制出新文件，再只在新会话上走 Pi `navigateTree`。原会话叶子不动。不总结、总结、自定义提示词仍传给这次导航。助手节点停在该条；用户节点回到父节点，原文只在新会话输入框为空时写回，不自动发送。成功后回执带新 `sessionId`，界面切过去，并立刻把新会话补进当前 sessions-index，不等重启重扫 jsonl。新会话沿用原会话的协作模式、已允许的工具，以及 `codemode`、`tool_search` 和 MCP（含内置 `node_repl`）：完全访问不再重新弹权限。分叉仍记下父会话，但不能因此当成子会话把这些扩展拿掉。总结成功后在新文件追加 `branch_summary`。导航后按内存里的 `getLeafId()` / `buildContextEntries()` 重放。不带 `label`。用户消息的分叉按钮在该行底部工具条里，和复制、编辑、回退放在一起，不浮在气泡旁边。其它行的入口是紧跟可见文字末尾的分叉按钮，不固定在行的右侧。点开仍是从这分叉、不总结、总结、自定义提示词，不再用右键。用户、还没有底栏的助手文本、单独的工具行都可以。一轮的最终回复已经有底栏分叉，不再画这颗按钮。收进查阅、执行、改动分组里的每条工具行也各有一颗；分组标题不是工具行，没有这颗按钮。工具行带的是 `toolCallId`。从工具调用分叉时，叶叶点是该工具结果；同一条助手消息里这个工具之后的工具调用和回复正文不进新会话。菜单或自定义提示词对话框开着时，这条消息用选中底色标出。压缩进行中拒绝。正在生成不打断原会话。选了总结或自定义提示词时，新会话先裁到目标并立刻切过去，摘要在新会话里生成。摘要正文直接留在时间线上，不收进「查看摘要」。原会话不显示「正在总结」。摘要进行时，输入框即使有草稿也要能停止，「正在总结」这一行也能点停止。Stop 打到新会话的 `abortBranchSummary()`，新会话留着，只是没有摘要。行上的分叉按钮和底栏分叉用同一枚图标。总结失败同样留着新会话。不回滚工作区文件。`editUserQuery` 仍走原来的 `navigateTree` 裁切，不进这条命令。

`readSessionTree` 把 `getTree()` 压成平铺节点，放在命令回执里，不进每条快照。压平用循环：一条几万层的父链用递归，打开会话时会栈溢出。`labelSessionEntry` 写 Pi 的 label，再回一份树。

`sendText` 的图片仍读成字节交给 Pi。其它附件不再在进模型前丢掉：文本文件把路径和最多 64KiB 正文附在 prompt 后面，PDF、视频和二进制只附路径。这段用 `<zcode-file>` 包住，用户气泡只留原文和附件芯片。Pi 在图片超过尺寸或换格式时，会把 `[Image: original … displayed at … Multiply coordinates by …]` 和 `[Image converted from …]` 拼进同一条用户正文，只给模型看。气泡、会话列表标题、回退进输入框的原文，以及按原文找回树节点，都去掉这些行。图片没发出去时的 `[Image omitted: …]` 仍留在气泡里。jsonl 里交给模型的原文不改。

模型请求失败后，输入框上方的错误横幅有重试。`continueAfterError` 不重发用户原文，也不截断会话。失败助手仍留在 jsonl 里，但下一次模型请求读的是 Pi session projection，不是内存里临时切掉的数组。只改 `agent.state.messages` 时，`prepareRequest` 会把末尾 `stopReason: error` 的助手消息装回请求；供应商把这条空助手当成已经说完，请求成功后立刻 stop，界面没有新输出。重试先对这些失败消息写 `appendContextEdit(id, null)`（与 Pi 自动重试的省略一样），再用 projection 刷回 `agent.state.messages`，然后 `agent.continue()`。尾部不是失败助手、或省略后仍停在已完成的助手上时拒绝。还在生成时拒绝。

`deleteSessionBranch` 删掉侧枝上当前路径用不到的条目并重写 jsonl；当前分支、生成中、压缩中都拒绝。当前路径不变，不重建模型上下文，也不重放对话。

删除（协议 + UI）：`sendGoalCommand`、`pauseGoal`、`resumeGoal`、`resumeWorkflowRun`、`startSavedWorkflow`、`amendWorkflowRunSettings`、workspace hook 审核三件套、`switchCollaborationMode`、`discardSharedContext`。

`editUserQuery` 重发用这次输入框里的模型。命令带了 `modelSelection` 就用它，不再套该轮最初的模型；没带时仍用原轮选择。

任意一条真实用户消息都能编辑重发，不限最后一条。会话还在生成时全部不可编辑。编辑仍从该条 `navigateTree` 裁切当前叶子并重发，这条之后的消息不再留在这条叶子上。

点发送或按回车后才选总结，不另加按钮。选项和从此处继续一样：不总结、总结、自定义提示词。选了总结时，时间线上先出现「正在总结被丢下的内容」，完成后再把摘要正文留在原处，然后重发。关掉选择则不发送。取消进行中的总结则不裁切、不重发。

用户消息在编辑旁边有「回退到此处」。先选不总结、总结或自定义提示词，和编辑后点发送一样。选完立刻关掉这个对话框，再发 `editUserQuery` 且 `restoreToInput` 为 true。总结进行时不留弹窗，进度只在时间线上。与编辑同一条 `navigateTree` 裁切当前叶子，不重发、不进入输入队列、不回滚文件。成功后把这条消息当时可见的原文和附件填进当前会话输入框，不自动发送。关掉选择则不裁切。输入框已有草稿或正在提交时拒绝，不覆盖、不裁切。取消进行中的总结则不裁切、不填入。

`applyFileRewind` 只退这一轮的文件，不截断聊天。真相是这一轮成功的 Pi 工具参数，不是旧 checkpoint。`edit` 要当前文件仍能唯一匹配 `newText` 才写回 `oldText`。`write` 要当前内容仍等于写入内容才删除该文件；覆盖掉的旧内容找不回来。对不上就整批不写。`bash` 只记为忽略，不阻止文件摘要上的撤销；编辑消息并选了回滚文件时，有忽略项仍拒绝。成功后把该轮 `fileChanges.state` 改成 `reverted`。SSH 工作区走和工具同一条远端读写。

`switchCollaborationMode` 不恢复为 PiCode 协作模式机。危险工具仍走 PiCode `PermissionService`（Pi 无权限面）：allow 放行、deny 拒绝、ask 投影 `kind: permission` 给壳 PermissionDialog（Allow once / Allow for session / Block）。session allow 由 HostedSession 记忆。`mode=yolo` 直接放行全部工具，不再弹权限窗。输入框切换权限立刻写到这个会话，不等下一条消息。切到完全访问时，正在等的工具权限按允许关掉。模式写进会话记录。会话异常停止后重建 runtime 时先恢复这份模式，再跑工具；不能因为内存丢了就回到 `build` 继续弹窗。输入框已经是完全访问、投影却不是时，再写一次模式，不能因为选项没变就跳过。插件 `confirm` 视为同意。`select` / `input` / `editor` 仍进底栏等人答，完全访问也不代答。`select` 把 `1. 标签 — 说明` 拆成问卷选项，回答仍回传原行。ask-me 在 GUI 上调用 `ui.ask(questions)`：问题、header、选项的 label / description / preview、multiSelect 按工具参数原样进问卷，不把示意拼进标题。没有 `ask` 的宿主仍走 `select` / `input`。其它模式的 `confirm/select` 同样走底栏 userInput，不用 viewport overlay。

## 死面

壳上拆掉：PluginStore、SavedWorkflows、Automations/OffPeak、CUA、Goal、PiCode 子代理 profile、官方 plugin 商店。设置改为已加载 Pi extensions 列表。插件页用 Pi `PackageManager.checkForAvailableUpdates` / `update` 检查并更新 npm、git 包。更新子进程不继承 app-server 的 stdout。本地 extension 文件和钉死版本不更新。装完后下次新建会话生效。

壳上新增：输入框 Extension Widget 槽。非计划插件的 status 收成上下文用量圆环左侧的一个 popup，不再平铺 chips，也不再占输入框上方。点开后列表向上展开。

宿主 UI 带上纯文本 `theme`（`fg` / `bg` / `bold` / `italic` / `underline` / `inverse` / `strikethrough` 原样返回文字，不发 ANSI）。缺 `theme` 时 Plannotator 在 `ctx.ui.theme.fg` 上抛错：批准计划后的 `plannotator_submit_plan` 和 `plannotator_mark_done` 都失败，`plannotator-progress` 清单也写不出去。清单仍由插件 `setWidget` 持有，输入框下不平铺这份原文。没有 TodoWrite 的 `plan` 时，状态面板的原 Todo 段用这份 widget 列出进度，不另写一份 plan。常规设置「显示待办」打开时，同一份 widget 在输入框上方画成可收起的待办抽屉，不写入会话行，也不进消息流。

计划审查不占着工具调用。`plannotator_submit_plan` 的结果带 `details.pending: true` 时，这一轮的 `turnHeader` 保持 `running`，时间线继续显示「工作中」，时长接着走。`control.phase` 仍收成完成：输入框可以接着发消息，不因为审查而排队或停住。所有者是投影器里的这一轮 id。插件用 `sendUserMessage` 把批准、拒绝或批注送进来时，这条仍是用户消息，右侧气泡保留。input source 是 `extension`；对上原文后先把审查轮收成 `completedSuccess`，再开新回合。审查期间自己打的字 source 不是 `extension`，不收口。审查还开着时，时间线是「工作中」，输入框也是停止键，不是发送键。离开计划模式、状态 `plannotator` 被清掉时也收口。插件通知审查页已关、没有批注或已批准时同样收口，不另开一轮。用户停止这一轮时按中断收口，不继续挂着。冷重放的工具结果没有 `details`，历史会话不会停在工作中；已经落盘的审查决定仍按同一条规则不画用户气泡。

Plannotator 打开审查页时，宿主优先把地址交给右侧普通内置浏览器，不改插件源码。插件仍走自己的 `openBrowser`。协议宿主在进程里拦住这次启动：调用栈来自插件的 `network.ts`，参数里有 http(s) 地址，且没有显式 `PLANNOTATOR_BROWSER`。拦住后发 live-only 增量 `embeddedBrowser.open`。它不进快照、不抬 conversation revision、不刷侧栏。桌面壳把它开成右侧浏览器页，和「用内置浏览器打开」同一条路径。没有内置浏览器的壳（网页、手机）用系统浏览器打开这个地址。纯 CLI 不安装拦截，插件仍开本机浏览器。拦截模块加载时不能调用 `createRequire(import.meta.url)`：桌面 Agent 是 CJS 包，`import.meta.url` 为空，一加载就退出，`--prepare-storage` 会让桌面只看到 `transport_closed`。对不上会话、或用户显式指定了 `PLANNOTATOR_BROWSER` 时放行插件原来的启动。多个会话里只有一个正在跑时，审查页归这个正在跑的会话，仍然交给内置浏览器。未设置 `PLANNOTATOR_GLIMPSE` 时宿主把它写成 `0`，避免 Glimpse 抢在本机浏览器之前打开。审查页在内置浏览器里关窗口时，桌面壳关掉这个侧栏页；webview 若只把已经打开的本机审查页换成 `about:blank`，同样关掉，不把空白页留在侧栏。会话归属跟当前执行上下文；只有一个会话时才用它兜底。两个会话同时打开、又对不上上下文时不猜，放行本机浏览器。

上游 0.28.22 起 `PLANNOTATOR_BROWSER` 的 none 值（`none` / `false` / `0` / `off` / `no` / `true` / `1` / `:`）一律不开任何浏览器，插件不再 spawn，拦截拿不到地址。插件不 spawn 的路径（这些取值，以及远程会话）改从插件的 `ctx.ui.notify` 里取会话地址：`Plannotator session ready: <url>`、`Code review opened at <url>.`（`Annotation opened` / `Last-message annotation opened` / `Plannotator: plan review opened` 同形）、`Could not open a browser automatically. Open <url> to review.`，取到的地址仍交给内置浏览器，和拦截走同一条 `embeddedBrowser.open`；没有内置浏览器的壳照旧退回浏览器新标签。显式指定了别的浏览器时（`chrome.exe`）交给插件，宿主不接管。同一个地址在一个会话里只交付一次：spawn 拦截先拿到就用它，通知里的同一地址不再开第二个页；审查页关掉之后同一地址可以再开一次（会话固定端口时前后两轮审查会拿到同一个地址）。

UI 设计模式是输入框模式菜单里的勾选，不是斜杠命令。点勾选发 `setUiDesignMode`，只改当前会话的内存状态，不写用户消息，不开新回合。状态键是 `ui-design`。勾选和关闭标记跟着这个状态走。新建任务先把勾选记在草稿上，创建会话后再发同一条命令。新建会话默认关闭。和计划模式互斥：打开一边时关掉另一边。

模式开着时，`write` 和 `edit` 只能改当前工作区 `designs/` 下的 `.html` 或 `.htm`。跑出工作区或换扩展名都拒绝。`bash` 和 `powershell` 整段拒绝。读文件和 `plannotator` 放行。每轮开始前把约束写进系统提示的 `ui_design` 段。用户消息开跑前，再在这条消息后面附一条不进时间线的 `ui-design` 说明：本轮必须把稿写进 `designs/` 的 HTML，不能用 Markdown、ASCII 或文字方案代替。说明里写明，系统提示没有 `ui_design` 段时忽略它，避免关掉模式之后旧消息还在起作用。模型如果没有任何工具调用就把这轮说完，而且这轮还没写成功 HTML，宿主再补一条同样不进时间线的消息，并续一次模型请求。一次用户消息最多续一次。中断、报错、这条回复里还有工具调用、或 HTML 已经写成功，都不续。续上之后写出 HTML，仍按下面的规则打开标注。HTML 写入成功后，宿主自己调用已加载的 `plannotator` 工具 `annotate` 打开这份稿，不等模型记得去做。失败的写入、命令和嵌套调用不打开。这和 TUI 里该工具返回 `terminate: true` 一样：第一次打开后立刻结束本轮模型输出，不再继续写下一句。时间线留在「工作中」，输入框是停止键。批注以用户消息回来，模型先把这轮修改和说明写完，轮末再打开下一轮标注。关掉审查页、或状态 `ui-design` 被清掉，工作中收口。批注回来只改同一份文件。关掉审查页不是通过。说「可以落地」不会自动关模式，也不会放行产品代码。审查页仍走上面的内置浏览器拦截。内置页在本机审查地址上补上 `window.glimpse.close`，并接住 `window.close`。插件先调 glimpse，没有时再调 `window.close`；webview 里原生 `window.close` 只会清掉页面，标签还留着，看起来就是空白页。两条都只通知宿主关掉这个侧栏页，不再调用原生关闭。guest 自己发出的 `close` 同样关页。同一个页面只关一次。

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

目录和只读侧栏仍用现有 V4 `subagents` 字段。子运行的 jsonl 写在父会话文件同名目录下的 `picode-subagent`，标题、摘要和启动时间仍读这份文件。不读 PiCode `subagent_child` 会话库，也不依赖 `pi-subagents` 插件是否安装。这些文件不进左侧会话列表：打开转录也不写进 sessions-index。按 id 查身份时把它们报成 `subagent_child`，任务索引修复会拿掉已经漏进去的行。对话分叉仍是左侧会话，不走这条。

`subagents.running` 只收录本进程活表里还在的子会话。扫 jsonl 时同样以这张表为准：表里还有的子会话保持 `running`（`waiting` / `blocked` 保留），并去掉 `endedAt`。表里没有的，即使文件没有助手正文、最后一条仍是 `toolUse`、或已经写下 `aborted`，也不再标成正在运行。

仍在跑的子会话打开侧栏时，jsonl 重放不把最后一轮收成完成。轮次保持 `running`，工时用消息时间戳，不用重放当时的墙钟。侧栏因此显示「工作中」并展开工具，而不是「已工作 1 秒」。文件在子会话结束前按秒重读；结束后再按完整轮次收口。已结束的历史文件仍按消息时间戳计工时。

正在跑的 `picode_subagent` 只活在当前进程里。父会话把这些活会话写进 `backgroundWorks`（`kind: subagent`，`workId` 和 `childSessionId` 都是子会话 id，`cancellable: true`），状态面板因此出现停止按钮。`cancelBackgroundWork` 只 abort 这个子会话，不停父会话。按下停止后这一行立刻离开「正在运行」，即使 jsonl 还没写成终态。

活着的子会话把当前 `provider` / `model` / `thought` 放进 `subagents.running`。状态面板用这份值和会话已有的模型目录展示下拉框。`setRunningSubagentModel` 只调用这个子会话的 `setModel` / `setThinkingLevel`，不改父会话，也不写设置里的默认。已经发出的请求不打断，下一次模型请求用新的。本进程没有的运行记录只显示目录，不能改。

运行列表上的角色名是 `picode_subagent` 的 `agent`，不是工具名 `subagent`。新子会话把这个名字写在 jsonl 旁边的 `.role`，并放进本进程活表。更早的文件没有 `.role` 时，从系统提示第一句 `You are <name>.` 读。两边都没有才留 `subagent`。

设置页拥有代理定义：用户 `~/.PiCode/agents`，项目 `<workspace>/.PiCode/agents`，内置 `scout`、`researcher`、`evidence-auditor`、`worker`、`reviewer`、`oracle`、`delegate`。这些角色对齐 [pi-subagents](https://github.com/nicobailon/pi-subagents) 的内置分工、工具和默认思考档位，不再提供 `general-purpose` / `Explore`。Pi 会话挂一个 `picode_subagent` 工具，按这份定义起子会话。子会话不再挂这个工具，也不挂 MCP。同名的 Pi 插件工具 `subagent` 在主会话上禁用，避免两套定义争用。

子会话模型的优先级与插件一致：设置里该角色的模型，然后是 Pi `settings.json` 的 `subagents.defaultModel`，最后是父会话当前模型。角色写了思考档位时用那一档，除非这次选择自己带了档位。`defaultModel` 写了但目录里没有时直接失败，不改用父会话。显式指定的模型同样找不到就失败。

## MCP

用户 MCP 的主人是 Pi：用户级 `~/.pi/agent/mcp.json`，项目级 `<cwd>/.pi/mcp.json`，都是 `mcpServers`。设置页仍写这两个文件。侧栏的项目 MCP 按钮只写当前工作区的项目文件。目标文件还不存在时，把旧的 `~/.PiCode/cli/config.json` 或 `<cwd>/.PiCode/config.json` 里的 `mcp.servers` 拷过去一次；之后只认 Pi 文件。项目条目覆盖同名的用户条目。SSE 不连。`directTools: true` 写成 Pi 的 `exposure: "direct"`，没写则是 `codemode`。

桌面 `--prepare-storage` 只解析会话库路径，不迁移、也不创建 Pi MCP 文件。这个 Worker 不能改 cwd，Windows 上继承到的目录经常是 `C:\Windows\System32`。在那里创建项目 `.pi` 会 EPERM，进程在写出库路径之前退出，桌面只能看到传输中断。迁移仍只发生在真正的会话进程里，并且用该工作区当项目目录。

会话加载 Pi 的 `codemode`、`tool_search` 和 MCP 扩展，不再注册 PiCode 的 `mcp` 代理工具。插件 MCP 和内置 `node_repl` 不进这两个文件，会话创建时用 `registerMcpServer` 注册。`picode_subagent` 拉起的子会话不挂这三个扩展。对话分叉不是子会话：新会话仍加载它们，`codemode` 和 `mcp__node_repl__js` 不会因为带了父会话 id 而消失。

浏览器和官方鉴权仍走这条 Pi 连接。`node_repl` 的每次请求带 `com.zcode/request-context.session_id`。官方 HTTP 仍用现有的逐请求 JWT fetch；官方 stdio 仍把身份头放进 `_meta`。设置页和侧栏项目 MCP 对话框打开时只读配置，不自动 connect。用户点刷新，或在设置里启用一台服务器时，状态检查仍可能再打开一份 `McpPort`，与会话里的 Pi 连接不是同一个客户端。

## 持久化与旧会话

对话树真相是 Pi jsonl，与 Pi TUI 共用 `~/.pi/agent/sessions/<encoded-cwd>/`（文件名 `timestamp_<id>.jsonl`，header id 为 sessionId）。新建/fork 写这里，不预建空文件（Pi 在首条 assistant 落盘）。仍枚举旧 `~/.PiCode/pi-host-sessions/<identity>/` 以免丢本 Host 已写过的会话；文件名是 `timestamp_<id>.jsonl` 时列表 id 用 header，不用整段文件名。列表时间用会话 header 和最后一条用户/助手消息；分叉抄来的旧消息、以及打开时写入的 label，都不能改这个时间。sessions-index 只列出有过用户消息（或 `session_info.name`）的文件。删除会话时关掉活着的 runtime，并删掉该 id 在本机目录和旧 hosted 目录里的 jsonl；列表行随后消失，不留可恢复的副本。壳项目列表以这份摘要为行集合，tasks-index 只提供 pin/archive/unread。重开只画当前叶子到根的那条分支，文件里被改掉的旧消息不再出现。分叉不再只限最后一条：任意已完成轮的助手回复都可以分叉，新会话走 Pi `createBranchedSession`，文件里只保留到该节点的路径。分叉点必须是树节点 id。实时行刚建出来时是 `row:N`；Pi 在把 `message_end` 交给监听者之后才 `appendMessage`，节点 id 与消息对象不是同一个。助手消息落盘后把这一行的 entityId 改成节点 id。若载荷带的是消息 id，先按 `message.id` 对上节点再分支；对不上就拒绝，不整份复制会话。某个会话正在总结被丢下的分支时，这个会话不能再分叉、再开分支、改标签或删分支；停止当前总结后才可以。停止本身不受这道闸限制。进行中的「正在总结」行要写进投影，总结结束或取消时把它撤掉，不能只发一条加行、结束时对不上。分叉出来的新会话标题是 `分支-` 加上原会话标题；原标题为空时就是 `分支`。这个标题算用户指定的名字，不再被自动总结盖掉。打开或冷订阅时 Registry 用同一份 jsonl 重放到 `PiToV4Projector`。不打开、不导入旧 PiCode event log。

## Model

主路径：`ModelRuntime.create()` 读 Pi 标准 `auth.json` / `models.json`，`createAgentSession` 不传 `model` 时走 settings 默认或第一个可用模型。壳上不再打开 PiCode WelcomeScreen/登录门禁。

SDK 来源是 `AppSettings.piSdkSource`。缺省 `builtin`，用打进 `zcode.cjs` 的 `@earendil-works/pi-coding-agent`、`pi-ai` 和 `pi-mcp`，当前都是 1.2.0。`global` 时 Host 注入 `ZCODE_PI_SDK=global`，进程里只解析一次本机 `npm root -g` 的同名包。主次版本必须和内置包一致，并且要有 `createAgentSession`。找不到、版本不一致或加载失败都继续用内置，原因记在 `runtime/capabilities` 的 `piSdk.reason`（`missing` / `incompatible` / `load-failed`）。改设置后重启应用再生效。委托测试用的 `createDelegateProvider` 仍走内置 `pi-ai`。设置页「通用」展示当前生效的 Pi SDK 版本号（徽章与说明），并在来源选项中提供对应版本标识。

设置页的 HTTP 代理和「不使用代理的地址」仍写 `AppSettings`，由 Host 在拉起 agent 时注入 `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY`。CLI 仍会清掉进程里的标准 `HTTP_PROXY` / `NO_PROXY`，避免用户 shell 代理泄漏。清完之后只把这两个 ZCODE 值写回标准变量，并用已有的 `createNetworkProxyFetch` 换掉 `globalThis.fetch`。Pi 模型请求走这层 fetch；Pi bash 继承进程环境，curl/git 因此读到同一套规则。绕过规则与旧模型出口相同（主机、前缀点、端口、`*`）。没配代理则不换 fetch。改设置后下次启动 agent 生效。普通 MCP 的 HTTP 走这层 fetch；官方 HTTP 仍用原来的鉴权 fetch。

**目录所有者：** Pi `ModelRuntime.getAvailableSnapshot()`。CLI 在 `workspace/readPresentation` 上行目录；Host `IModelSelectionService` 只投影这份目录，不再用 PiCode Provider Registry 当聊天/设置页候选。投影必须把 `getView(input.selection)` 写成 `effectiveSelection`，否则 Composer 触发器拿不到当前草稿模型。Composer 与设置「模型设置」共用该视图。`switchModelConfig` 走 `session.setModel`。空闲时输入框里的模型属于下一次提交，在 `prompt`、steer 或手动 `/compact` 之前写入。压缩不读会话里的旧模型。会话已经在跑时，输入框一切模型或思考档位就立刻 `setModel`：已经发出的那次请求不中断，同一轮里的下一次模型请求用新的。排队项仍带着入队时的选择，出队再换。

设置页通过 `pi/models` 读写 `~/.pi/agent/models.json`（apiKey 明文回读，输入框不脱敏；保存时空字符串清掉密钥，请求不带 `apiKey` 则保留原值）和 `settings.json` 默认模型与思考等级；保存后 `registerProvider`/`unregisterProvider` 更新活着的 `ModelRuntime`。打开设置页的 `get` 只读这份目录，不等 `workspace/readPresentation`；改完模型后的展示刷新放到后台，不挡住设置页。`get` 和插件 `list` 在协议入口不跟会话命令排队。渠道的 `api` 是默认请求格式。模型项没写 `api` 时补成渠道的；写成另一种驱动时保留，运行时用模型项上的 `api`。壳不另写 PiCode 供应商库。PiCode 账号登录、升级套餐、Coding Plan 额度不再作为产品面。

模型设置界面包含两个标签页：「默认模型」与「供应商管理」：
- 「默认模型」页提供全局默认模型（供应商+模型ID）及默认思考等级（Reasoning Level）的直观选择与持久化，展示当前默认模型详细规格，并提供跳转至「供应商管理」的快捷入口；若未配置任何供应商或模型，展示空状态与前往添加供应商的操作。同页还有标题总结开关和可选的总结模型。开关缺省开启；总结模型留空表示跟随当前对话模型。这两项写在 `~/.pi/agent/zcode-title-summary.json`，不进 Pi 的 `settings.json`。
- 「供应商管理」页提供供应商与模型的增删改查、测试连接等管理能力。

设置页「使用统计」只恢复应用用量。事实源是本机 Pi 会话 jsonl：`~/.pi/agent/sessions` 和旧的 `~/.PiCode/pi-host-sessions`，含子目录里的子会话。只读，不写回旧 usage 表。每个文件只计当前叶子；分叉抄来的同一条消息按 id 只计一次。时间窗外的消息不计。Pi 的 `input` 不含缓存，汇总时把 cache 加进 input，命中率才不会超过 1。没有首 token 耗时和工具耗时，这两项留空。

## Pi 插件开关

设置「插件」页上面是官方推荐，下面是目录。「已安装」是目录筛选，不是另一个视图。选中时用和目录相同的卡片列出当前范围已经安装的包，保留开关、设置、更新和删除，不再请求这一页目录。官方推荐和目录都放在表面色带里，卡片仍用卡片色。删除走 `remove`：包调用 Pi 的 `removeAndPersist`，自动发现的扩展文件只删 `extensions/` 下的那个文件。市场最前面固定三张宿主已经接上界面的包：`@plannotator/pi-extension`、`pi-processes`、`pi-ask-me`。这三张只显示名字、短标签和宿主上多出来的行为，没有图标。当前范围已经有同源的包时，卡片上是「已安装」，不再给第二个开关。没装的可以单独安装，也可以一次装上还没装的那几个。页面搜索框同时过滤已安装列表和这三张；对不上的固定卡片隐藏。它们下面是 npm 上关键字 `pi-package` 的目录卡片，来自 `https://registry.npmjs.org/-/v1/search`，一页 12 条，用页码翻，不追加。页码居中，当前条数范围写在页码旁边。输入框不自动搜索，按下搜索才发。类型筛选把 `extension`、`skill`、`theme` 或 `prompt` 作为额外关键字和 `pi-package` 一起查；没有该关键字的包不进该类型。排序「热门」把 npm 的 popularity 权重设为 1、quality 和 maintenance 设为 0。注册表没有全局按时间或按名称排序，「最新」和「名称」只重排当前这一页。卡片按目录站的结构排：名字、说明、发布者、版本、发布时间、类型和安装命令。不显示月下载，注册表搜索没有这项。插件页比其它设置页更宽，宽屏时目录一行放更多张。图标只来自该版本 `package.json` 的 `pi.image`：https 地址直接用，包内相对路径换成 jsDelivr。没有、超时或不是 https 就不显示图。官方推荐只保留这三张，并写明各自接到界面上的用途。手填源在弹窗里，写入当前页面范围。空查询就是这个关键字本身。npm 的文本搜索会混进没有这个关键字的包，结果只留关键字里真有 `pi-package` 的。目录不落盘。搜索还在飞时后一次结果到了就丢掉，不覆盖后一次。另外可以手填源：`npm:<包名>`（可带版本或 tag；没有前缀的包名也当 npm）、`git:<主机>/<路径>`、`https://<主机>/<路径>`。本地路径、`file:`、`http:`、带查询串、用户信息或 shell 字符的源拒绝。安装走 `install`，写入当前范围的 Pi `settings.json` 包列表（用户级或工作区级），不写 `pi-plugin-switches.json`；新装上的包跟随 Pi 的默认启用。同一范围里，npm 包名对上（忽略版本）或 git/https 源原文对上时算已安装，不再下载。三个固定行仍用原来的名字针：本地目录名 `pi-processes` 就是 `https://github.com/Otherworldy/pi-processes-bash`。git 源的安装目录如果已经在托管根里面、但没有 `.git`、并且 `git rev-parse --is-inside-work-tree` 也不是仓库，安装和更新会先删掉这个半截目录再交给 Pi。否则 Pi 会当它是已有仓库，跑 `git rev-parse origin/HEAD`，失败信息是 not a git repository。已经是 git 工作区的目录不删。Windows 上删不掉（`EPERM`）就留着，不把删除失败当成安装失败。安装时如果这个目录已经是 git 工作区，不再克隆或删除，只把源写进当前范围的设置。Pi 自己因为 `EPERM` 删这个目录失败、但目录仍是 git 工作区时，同样写成已安装。托管根外面的路径不删。半截目录清掉后仍报 not a git repository 时再清一次并重试，仍然失败就把原错误交出去。npm 和 git 的输出仍不能进协议 stdout。安装或更新失败时，子进程的错误输出留在错误信息里返回。设置页安装失败显示这段原因，不再只提示无法更新。已打开的会话不热更新，下一次新建会话才加载。`list`、`search` 和 `prerequisites` 是只读，协议入口不跟会话命令排队。`prerequisites` 在实际安装插件的那个进程里执行包管理器命令和 `git` 的 `--version`，标准输出丢弃。默认包管理器是 `npm`；Pi `settings.json` 的 `npmCommand` 有值时探测那条命令，结果仍记在 `tools.npm`。命令不存在、退出码不是 0，或 8 秒内没有退出，都算没有。设置页缺哪个就在顶部提示安装 Node.js 或 Git，目录仍可浏览。`install`、`remove`、`checkUpdates`、`update`、开关和写配置仍串行。列表来自 Pi `settings.json`（用户级 `~/.pi/agent/settings.json`，工作区级 `<cwd>/.pi/settings.json`），但开关不写回这两处。检查更新和更新都走 Pi 的 PackageManager，但更新用的那个实例不能让 npm/git 继承进程 stdout。app-server 的 stdout 只能是协议帧；npm 成功时打印的 `changed 1 package` 会被 Host 当成 JSON，解析失败后关掉 Agent，设置页就显示更新失败。子进程 stdio 用 ignore；Windows 上的 npm/pnpm/bun 仍经 shell 启动。检查更新仍用 Pi 自己的管道捕获。可更新结果落在 `~/.PiCode/pi-plugin-update-cache/`。用户范围的包全局一份，键是 `scope:user`，因为它们装在用户目录，不随工作区变化；旧的按工作区文件里的用户范围记录不再读。项目范围仍按工作区，键是 `workspaceIdentity?.trim() || workspacePath`。`list` 合并这两份，不访问网络，设置页因此能直接显示上次的更新按钮。两份都有成功检查时间才算查过，对外的检查时间取较早的一份；缺一份或读不出来就当没查过。`checkUpdates` 成功后按范围覆盖结果和检查时间。比已落盘的检查更早开始的结果直接丢掉。检查期间更新或卸掉的包，这次结果也不能把它写回可更新。`update` 或 `remove` 成功后立刻从对应缓存去掉这个插件，不改检查时间。应用启动后，若当前工作区还没查过或距上次成功检查已满 24 小时，就自动检查；之后每 24 小时再查。自动检查只有发现可更新才提示，不提示已是最新。手动检查仍提示两种结果。PiCode 的开关注 `~/.PiCode/pi-plugin-switches.json`，只在 PiCode 创建会话时叠加：关掉的包或扩展文件从这次会话的 extensions、skills、prompts 里拿掉。只改当前数组不够：其他扩展 `resources_discover` 追加资源时，Pi 按原先的技能路径整表重载，关掉的包技能会再进系统提示。加载器在 `reload` 和 `extendResources` 返回后再套一次同一份开关。没有活会话时的技能目录也按这份开关掉包技能。Pi 里关着、PiCode 里开着的，只在 PiCode 会话额外加载。Pi TUI 仍只看自己的 `autoload` 和 `extensions`。没在 PiCode 里动过的插件，跟随 Pi 当前状态。已打开的会话不热更新，下一次创建会话才生效。不再把 PiCode 插件市场当能力源。`plugins/*` 协议方法已删除，设置页不再列、安装或开关 PiCode 插件。

插件自己的设置不进 `settings.json`。能改的只有已经存在的 `~/.pi/agent/extensions/<名字>/config.json`。`list` 顺带这些文件里的顶层开关、数字和文本；`writeConfig` 只覆盖同名且同类型的顶层项，嵌套对象、数组和没出现过的键保持原样。不新建配置文件，也不执行插件代码去猜它的设置项。设置页不把这些表单铺在列表下面：能对上配置文件的插件，行内一个「设置」按钮，弹窗里改。改完同样从下一次新建会话生效。

技能设置读写 Pi 会加载的目录：用户 `~/.pi/agent/skills`，工作区 `<cwd>/.pi/skills`，仍列出 Pi 同样会读的 `.agents/skills`。已启用的 Pi 包技能也列出：读包里的 `pi.skills`，没有这份清单时用包内 `skills/` 目录。用户包出现在个人范围，项目包出现在当前工作区，归在包名下，不能单独删除或用技能开关关掉。Pi 里 `autoload: false` 的包，以及 PiCode 插件开关关掉的包，不列。设置页不执行扩展代码，扩展只在运行时 `resources_discover` 上报的技能不在这里。包设置里非空的 `skills` 过滤模式不重复解释；`skills: []` 仍表示这个包不贡献技能。斜杠菜单不另扫一套：已打开的会话用 Pi 已经加载的技能（含用户目录、沿 git 根的 `.agents/skills`、已启用的包技能）；没有会话时走 Pi 的包解析，不加载扩展。命令区只留 GUI 能用的：`/compact`、提示词命令，以及扩展注册的命令。扩展命令单独一组，不和原生命令混在一起。当前会话已经注册的扩展命令，提交后由 Pi 立刻执行：不写用户消息，不开模型回合，会话正忙也不进输入队列。发送回执不等命令里的提问结束，否则第一个选择框会把后续命令堵住。关掉当前提问（忽略或停止）就取消这次命令剩下的提问，不用把向导走完。命令里的 `ctx.ui.notify` 叠进一个可关闭的弹窗，不写进对话，也不进模型上下文。新建任务上的扩展命令留在当前页执行，不把草稿提升成侧栏里的新会话。选择和输入也是可关闭的弹窗，每一步都能忽略。这个会话没有注册的同名输入仍按普通消息发送（提示词模板仍展开后发给模型）。终端专属内置命令（`/copy`、`/new`、`/resume`、设置、模型选择、退出等）不展示，打出来也不发给模型。Pi 把技能注册成 `skill:` 命令；GUI 不收录，技能仍在原来的技能区。`/side` 仍是 GUI 自己的。计划模式只跟已启用的 `@plannotator/pi-extension`。没装或没启用时，输入框不显示计划开关，`/plan` 直接拒绝。新建任务里的开关和空 `/plan` 只记在草稿上，不创建会话。真正发出第一条消息时才先发送 `/plannotator-plan-mode`。这条命令和其他单独的斜杠命令不当会话标题，标题仍取之后第一条真正的用户消息。会话库 `first_input` 和任务索引同样不保留这条命令；列表摘要里已经有真实标题时直接换上，不必先点开会话。已有会话的开关直接发送该命令。带正文的 `/plan` 先进入计划模式，再把正文发给模型。PiCode 自己的 `planEnabled` 不再发给 Host。命令设置读写 Pi 提示词目录：用户 `~/.pi/agent/prompts`，工作区 `<cwd>/.pi/prompts`。斜杠菜单每次列出都再扫这两个目录，不把提示词冻结在进程里最早的那个会话上。保存后再次打开 `/` 就能看到新命令。当前会话还没载入该文件时，发送前按磁盘模板展开；已经载入的仍由 Pi 展开，包里的模板不被覆盖。删掉的文件留在已经载入它的会话里，直到该会话结束。钩子不进入 Pi 会话，设置页不再单独列出。

内置浏览器是宿主能力，不是可安装插件。会话创建时直接连上打包好的 `node_repl`，并把 `control-browser` 技能交给 Pi。工具名仍是 `mcp__node_repl__js`。direct 调用带上当前会话 id，browser broker 才能回到 `BrowserControlPort`，再调 Electron `interaction/browserExecute`。不写进用户 MCP 配置。开关在 `~/.PiCode/v2/setting.json` 的 `browserHostEnabled`，缺省开启，只影响之后新建的会话。子会话不带这个工具。对话分叉出来的新会话仍带。

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

停止这个前缀只发插件的 `processes:command:kill`，不调用 `session.abort()`。日志走原来的 `readBackgroundBashOutput`，读插件的合并输出；侧栏仍按一秒轮询，跑着就继续读。进程结束就离开列表，不写入会话 jsonl。插件的 `combined_output` 按行返回 `text`，行尾换行不在文本里，桥接必须逐行拼回换行，否则多行输出会黏成一行。命令自身把输出重定向到文件时（`> log 2>&1`），插件日志本来就是空的，侧栏显示空不是读取失败。

`/ps` 和 `ps:` 开头的命令是 Pi TUI 的。GUI 不展示，打出来也不发给模型。模型继续用插件的 `process` 工具。没装这个插件时列表为空，停止和读日志都当不存在。SSH 工作区里插件起的是本机进程，不是远端 shell；远端命令仍走现有的 ssh bash。

## 明确不做

- 用 customTools 包装 PiCode 旧工具 handler。子代理和 MCP 例外：这两项由 PiCode 持有定义，Pi 只负责调用
- 渲染进程跑 `pi-tui`
- `pi --mode rpc` 子进程当内核
- 为手机另起 Pi
- 终端 TUI
- 专项插件 renderer（名单后补）
- `AskUserQuestion` 与设置项「提问自动继续」。当前会话不注册这个工具，也不再按 5 分钟自动结束提问。权限确认和计划审批仍走原来的交互。
