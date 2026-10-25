# 打开耗时

时间线第一次把某个 `sessionKey` 的行提交进 DOM 后，打一行 `ui.v4.conversation.first_frame`。`firstFrameRenderMs` 只算这次渲染到 layout，不算宿主读 jsonl 或建 Pi 会话。没有行不打。草稿（`sessionKey` 为 `draft`）不打。换会话再打一次。生产构建走 lifecycle 日志。宿主三段耗时见 `apps/zcode-cli/packages/pi-host/SPEC.md`。

# 对话工作折叠

## 行为

一个 turn 里的 assistant 正文（`assistantText`）是工作折叠的边界，不进折叠内容。

- 正文始终显示在块外。
- 两段正文之间的工具和思考各自成一块，单独折叠，互不影响。
- 只有空白的 assistant 正文不是边界，也不显示。工具回合里模型常带一段 `\n\n`，它不能把连续终端调用切成多块。
- 每块标题只报自己的工具次数和时长（「调用 N 次工具，工作 …」），块一结束就固定，不跟着整轮计时走。
- 正在工作的那一块报当前动作；工时和次数不在这里，归轮尾那行。这一块默认展开，箭头随时可点，跑着也能收起。第一块结束得早时只报那次调用的耗时，不会顶着累计工时一直走秒。
- 动作按 dsh 的 `ProcessActivity` 分类（`v4/workChunkActivity.ts`）：读、读图、搜索、写、改、命令、代码、网页搜索、网页抓取、子智能体、计划、提问、技能，其余工具落到「正在调用工具」；工具名按 snake_case 归一，`Read` 与 `read` 是同一个动作。
- 每个动作备三条同义文案，按「块 key + 净工时」每 8 秒顺次轮换（`workActivityPhraseKey`）。不取随机数：同一块同一个工时永远算出同一条，否则每秒重渲染都在闪字；不同块起头不同，跨对话不重复。
- 状态分三种：参数还在流（`inputStreaming`）说「准备…」，开始执行说「正在…」，等审批说「等待你的操作」。准备态只有一句，不参与轮换。
- 判定先看还有没有在跑的工具；explore 的父阶段会跨过子工具 success，所以这块是当前阶段时，落定的子工具仍报它的动作。没有在跑的工具才取最后一条看得见的行，空的思考行（`reasoning_start/end` 的空 block）不参与。
- 轮尾运行行是「转圈图标 + 工时 + 次数」，例如 `⟳ 用时 2 分 11 秒 · 调用 20 次工具`（`chat.loading.workStats`）。不再把「工作中」写成文字：转圈本身就够表达在跑，前面再顶一个词只是冗余。工时是本轮净工时，次数按整轮 `assistantWorkRows` 的 `toolCall` 行累计，用户中途插话形成多段也合计整轮。
- 图标和数字都用中性色阶：图标 `text-foreground-subtle` 实色转圈，数字走与工作块标题同一套扫光（`zcode-working-shimmer`，底色 `foreground-subtle`、高光 `foreground`）。扫光是 `background-clip: text`，只包数字，不能包住图标。秒数走等宽数字位，宽度不跳。
- 中断轮的「已停止」挂在最后一块工具块上。
- 没有可折叠的工具块可切时（例如一轮只有正文），状态行同样只报动作（「正在回答」），工时和次数仍只在轮尾。
- 时长报的是净工作时间：「这个活干了多久」，不是用户等了多久。权限审批、`ask_user_question` 提问和 workspace hook 审核的等待不算工时。等待区间由 CLI 投影按 `permission_requested`/`permission_resolved`、`workspace_hook_review_requested`/`workspace_hook_review_settled` 的事件时间戳累计，客户端不自行判断谁在等。运行中整轮用 `waitedMs` 加当前 `waitingSince` 继续扣，等待期间秒数不走。
- 后面的块标题同样写出这一块的工具次数和时长，始终有箭头，可以单独收起。
- 工作已经结束的工具区默认收起。轮次还在跑时，只展开最后一块、且后面还没有 assistant 正文的工具区；正文一出现，前面的工具区就收起。用户仍可手动展开已结束的块。轮次结束后全部默认收起。
- `ask_user_question` 留在折叠外，收起工作块时问卷还在。
- `<process_event>` 通知不是正文：不切开折叠，只显示 summary。
- 纯 Computer Use response 里的正文仍留在 CUA 分组内，不用它切开分组。
- 压缩分隔线，以及折叠区外的插件 UI 卡片，不进这些块。
- 分段时长与整轮同一口径：`workSegments[].activeMs` 同样排除等待，运行中用 `workSegments[].waitedMs` 加 `waitingSince` 扣。
- 一块里的连续工具项内容区限高 `min(400px, 50vh)`，超出在块内滚动，能滚的方向上给 24px 渐隐（口径照 dsh 的 `ChatGroupSeat`）。只有一块里至少两个工具项时才套这层限高，单张工具卡不套：它自己的输出区已经限高，再加一层只是多一条滚动条。
- 限高容器只装工具和思考，不装正文。正文混进滚动框会让读正文也得先在框里滚一遍。
- 压缩摘要（`timelineMarker` 的 compact / branchSummary）展开后套同一个限高容器，但不吸底：它动辄几千字，不限高会把后面的轮次顶出几屏；摘要是静态内容，没有尾部可跟。
- 运行中的块自动吸底，新工具一出现就在视野里；读者自己往上滚过之后停止吸底，直到重新滚回底部。已结束的块不吸底，保持读者自己的位置。
- 块内滚到边界时把滚动交还给页面（`overscroll-behavior-y: auto`），不能把指针锁在块里。
- 块内只纵向滚：`overflow-x: clip`，不因为内容横向溢出一冒出横条，也不给这一层加宽度上限。横向溢出交给工具卡自己的输出区处理。
- 思考行显示具体时长（「持续了 12 秒」），不用「持续了几秒」。有 `durationMs` 用它；否则同一批工具共用消息时间时，用这条消息与上一条更早事件的间隔，实时思考则用下一条更晚事件的间隔。

## 所有者

每一块的开合状态只活在对应 UI 组件里，不是会话事实。刷新后回到上面的默认开合。

块内滚动位置和「是否贴底」同样只是 UI 局部状态，不进协议，也不跨会话记忆。

# 本轮用量

## 行为

- 在每轮对话末尾的操作栏里渲染一个用量 pill，位置紧跟在复制、反馈、fork、hook 按钮之后，消息时间戳之前，与 dsh 同一处。标题写「用量 N tok」，N 是本轮总 token 数（未缓存输入 + 缓存读取 + 缓存写入 + 输出）。
- 点 pill 从上方弹出明细，再点外面或再点一次收起。弹出层列出：提供方 / 模型、缓存命中率、未缓存输入、缓存读取、缓存写入（为 0 时省略）、输出、本轮吐字速度。开合状态只活在这个 pill 里，换会话或刷新后回到收起。
- 操作栏常显，不依赖悬停。它排在所有轮内内容（包括 `assistantTailRows`）之后，占文档流高度，不做浮层，否则会压住下一轮。
- 缓存命中率是 `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`。Pi 的 `usage.input` 不含 cache，三类互不相交，相加就是这一轮的 prompt 总量。不能用 `cacheReadTokens / inputTokens`：实测 `input=22`、`cacheRead=3840` 会算出 17400%。
- 吐字速度是 `outputTokens / (llmDurationMs - ttftMs)`。分母是首 token 之后的解码时间：工具执行、等待审批都在首 token 之前或之外，自然不进分母；思考 token 计入 output，所以思考那段的解码时间留在分母里。`ttftMs` 缺失，或者扣完不足 100ms（墙钟差值不可信）时退回总时长。输出为 0、或算出来不足 1 tok/s 时不显示这一行。
- 卡片只统计当前会话自己的模型调用。子代理在独立会话里跑，它的 token 不计入父轮的这张卡。
- 提供方与模型取本轮最后一次模型调用。一轮里换过模型时卡片只显示最后一次，不按调用拆开。
- 运行中的轮同样显示，数字是本轮到现在为止的累计值，随每次模型调用更新。
- 历史会话重开后卡片照旧显示。用量和时长跟着 assistant 消息一起落 jsonl，重放时从消息本身读，不从重新计算的时间戳猜。

## 所有者

本轮用量的所有者是 CLI 投影（`apps/zcode-cli/packages/pi-host/src/projector.ts`）。它从 Pi 的 `message_end` 读 `usage`、`timestamp`、`durationMs`，累加进 `turnHeader` 行的 `usage` 字段，客户端只读不算。

TTFT 由投影在收到首个文本或思考增量时用本机时钟打点，Pi 不提供这个数。历史重放没有首 token 时刻，`ttftMs` 缺省，命中率与总量不受影响。

`cost` 不参与这张卡：订阅制下目录价和实际账单不是一回事，模型配置里的 `ZERO_COST` 也会把它按 0 写出。

## 失败

`usage` 缺失（legacy 消息、provider 不报用量）时不画 pill，不拿 0 填充。`usage` 全零（失败、中断、deferred 回填的调用）时整次跳过：它既不占 token 也不占时长，否则一次失败尝试会把整轮的首 token 等待抹掉。`durationMs` 缺失时只隐去吐字速度那一行，其余字段照常显示。

# 会话统计

## 行为

- 在输入卡片正下方渲染一行居中的统计，位置与 dsh 的 composer dock 一致。从左到右：会话 pill、token pill、Pi 扩展状态图标。空会话（累计 token 与轮次都为 0）时不渲染任何分析项，整行隐藏。
- 会话 pill 写「N 轮 M 步」，有解码速度时接上「· X tok/s」。点击从上方弹出明细，列出模型用时、工具调用用时、首 token 平均（TTFT）、输出速度（TPS）——与 dsh 的会话统计面板同一组指标，每项有值才显示。一条耗时都拿不到时 pill 不是按钮，纯文本展示，不弹空面板。token pill 写「X tok · 缓存命中 Y%」，X 是会话累计总 token 数。点击弹明细：缓存命中率、未缓存输入、缓存读取、缓存写入（为 0 时省略）、输出，标题右侧给精确总量。弹窗里每个 token 数都带 `tok` 单位，纯数字看不出是 token 还是次数。再点外面或再点一次收起，开合状态只活在这个 pill 里。
- 数字简短显示（`7.9K`、`1.2M`），弹窗里给精确值带千分位。字号比正文小一档，用三级文字色，数字用等宽数字（`tabular-nums`）避免跳动。
- 行宽不够时标签省略号截断，图标不缩；不换行、不横向滚动。pill 内部必须是 flex 容器：纯文本分支用裸 `span` 时 `h-6`、`gap`、`items-center` 对 inline 元素全部失效，图标与文字会折成两行。
- **一步 = 一次产生了用量的模型调用。** 失败、中断、deferred 回填的调用 Pi 给全零 `usage`，不计步也不计 token，与本轮用量的过滤同口径。**一轮 = 一次开轮**，重试再发的 `agent_start` 不开新轮，也不重复计轮。
- 时间指标只累加真实可得的时长，缺数不拿墙钟估。模型用时取 `message.durationMs`；解码时长是「总时长 − 首 token 等待」，只在两者都有时累加；输出速度是 `decodeTokens / decodeMs`；工具耗时取工具行 `startedAt` 到 `endedAt` 的差值——重放 jsonl 时这两个时间共用同一个落盘时间戳，所以历史会话的工具用时会偏低，宁可为 0 也不编。
- 缓存命中率是 `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`，与本轮用量同口径。分母为 0 时不显示这一段，不留 `0%`。
- 统计只算当前会话自己的模型调用，子代理在独立会话里跑，不计入父会话这行。
- 历史会话重开后数字仍然是全量。Pi 回放把 jsonl 里 assistant 消息的 `usage` 搬回 `message_end`，同一个投影逐条累加，与实时同一条代码路径。
- 重放是幂等的。切分支、编辑重发、子代理 historyWatch 重画都会重新 replay 整份 jsonl，而累计量不在行里、`reload` 不会自动清它——所以 `reload` 必须先归零再重放，否则同一份历史会被反复累加，切一次分支数字就翻一倍。
- 回退与切分支一律走整份重放，不用「只删尾部行」的快捷路径：删行只清掉可见内容，而累计量是从事件流累加出来的，拆不回单个行，不重放就会把被回退掉的那条分支继续算在总数里。

## 所有者

会话累计量的所有者是快照的 `usage.cumulative`（`packages/shared/src/zcode-protocol-v4/snapshot.ts`），由投影单点写入，客户端只读不算：

- Pi 路径：`apps/zcode-cli/packages/pi-host/src/projector.ts`。`recordTurnUsage` 在累加本轮用量时同步累加 `cumulative` 与 `steps`，`startTurn` 累加 `turns`。
- store 物化路径：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`，`onModelComplete` 累加 token 与 `steps`，`onTurnStarted` 累加 `turns`。

不引入种子：冷恢复时 Pi 投影本来就要逐条重放 `message_end`，累计量自然补齐，再写一份 seed 就会出现两个写入方。`usage.contextWindow.usedTokens > 0` 那类早退门只该管上下文水位，不该拦累计量。

计数不在种子里。`seedUsage` 只补 token 水位，轮次与步数保持当前值；旧 Host 发来的快照没有这两个字段时 schema 按 0 补齐，不能让整帧校验失败。

## 失败

`usage` 四项全零的调用整次跳过，不占步数也不占 token——包括冷恢复合成的零用量 `ModelComplete` 占位事件，否则重开一次历史会话步数就白涨一轮。累计量单调递增，不因轮被中断或失败回退。历史会话若 jsonl 里本来就没写 `usage`（早期会话），累计值从 0 起算，不拿上下文水位反推。

# 分支摘要



## 行为

- 完成后的分支摘要默认收起。点分隔线展开或收起，文案带「查看摘要」，与压缩摘要同一套开合。
- 总结进行中（「正在总结被丢下的内容」）分隔线上没有停止按钮。停止只走输入框的停止按钮。

## 所有者

开合状态只在这一行的分隔线组件里，不是会话事实。刷新后回到收起。

# 输入框待办抽屉

## 行为

- 设置「显示待办」不再显示历史 `TodoRead` / `TodoWrite` 工具行。这些行在消息流里始终不渲染，包括嵌在分组里的整张工具卡。消息流里也不再放待办卡。
- 开关打开，且当前快照的 `plannotator-progress` 能解析出条目时，待办用待发信息同款顶条：圆角顶边、边框、不透明 `#f0f0f0`，底边垫在白底输入框后面，不包住输入框。默认收起，只留当前项和完成数。点这一行展开全部条目，再点收起。高度沿用工具卡的折叠动画，箭头在 300ms 内转 90 度。
- 开关关闭、widget 缺失或没有可解析条目时不画抽屉。分享流程换成分享底栏时，抽屉跟着输入框一起让开。
- 不把 widget 写成工具行，不进会话历史，不改协议。清单只跟当前快照里的 widget。重开后要等插件再次 `setWidget`。
- 状态面板的待办段不受这个开关影响。两处可以同时出现。

## 所有者

widget 文本的所有者是 Pi extension UI（`setWidget` → 快照 `extensionWidgets`）。抽屉只读这份快照，不另存一份清单。开关是应用设置 `messageStreamShowTodos`。展开或收起只活在这个抽屉里，换会话或刷新后回到收起，不是会话事实。

## 失败

解析不出 `☑` / `☐` 行就当没有清单，不画空抽屉，也不报错。

# 状态面板里的子智能体

## 行为

- 正在运行的一行只显示角色名（`subagentType`，例如 `scout`），不显示任务摘要，也不把工具名 `subagent` 当成角色。角色名为空时留空，不回退到摘要。角色名右侧同一行是这次子会话的用量 pill。
- 用量 pill 写「总量 + 单位」（`83K tok`，24px 高，和模型 chip 同高），点击在卡片内展开或收起明细；点它不打开子会话。没有 `usage` 时不画 pill。
- 等待或阻塞且没有用量时，pill 的位置换成一个小胶囊状态文字（复用 `subagentDirectory.status.waiting` / `blocked`，虚线边框）。
- 时长独占一行。模型、思考档和停止排在下一行，高度都是 24px。停止是同高的图标按钮，不带「停止」文字，也不和下拉框挤在同一行里换行。
- 时长后面接吐字速度（`42 tok/s`）。没有输出、没有时长或不足 1 tok/s 时整段不出现。
- 卡片底部贴一条 3px 的用量构成条：缓存（读取 + 写入）、未缓存输入、输出三段，宽度按 token 占比，颜色依次用 `--color-usage-chart-1` / `--color-usage-chart-2` / `--color-usage-chart-3`。总量为 0 时不画。
- 展开的明细是两列六格：缓存命中率、未缓存输入、缓存、输出、吐字速度、总用量，下面一行三色图例。开合只活在这个面板里，换会话或刷新后回到收起。
- 数字只由 `turn-usage` 的派生函数算：总用量 = 未缓存输入 + 缓存读取 + 缓存写入 + 输出；命中率 = 缓存读取 ÷ prompt 总量，没有 prompt 时写「—」，不写 0%；吐字速度低于 1 tok/s 不显示。token 固定用 K/M 单位，不跟 locale 走。
- 点分区标题「智能体」打开子智能体目录。右侧箭头仍只负责展开或收起这一区，并且一直可见。没有父会话或没有目录回调时，标题恢复成展开开关。
- 「已结束」页脚仍打开同一个目录。

## 所有者

运行中的子智能体事实仍是会话快照。分区开合仍在 SessionPane 的 `agentSectionOpen`。打开目录仍走已有的 `onOpenSubagentDirectory`，不另开一条路径。

子会话用量挂在 `snapshot.subagents.running[].usage`（`TurnUsage` 形状）：Pi 宿主订阅子会话的 `message_end` 在活表里累加，`publishSubagents` 去抖后把累计值写进快照；内核路径（`materializeSubagentProjection`）不产用量，对同一子会话沿用上一次的 `usage`，冷恢复 seed 则缺席，UI 自动退回原来的三行。UI 只格式化，不重算口径。

## 失败

目录打不开时不画一个点了没反应的标题。停止仍只在这一行有唯一的活会话控制句柄时出现。

没有 usage 时 pill、构成条和明细都不渲染，卡片回到三行；明细里的缺失值写「—」。用量不写进 `EndedSubagent`：结束后的卡片不在这个面板里。

# 子智能体工具卡的摘要行

## 行为

- `picode_subagent`（派发子智能体）没有专用卡面：详情、结果和展开交互沿用未知工具的兜底卡。
- 摘要行不显示 wire 名 `Picode_subagent`，也不显示兜底卡的扳手图标和「工具调用」主文本：显示「子智能体」、子智能体图标（与 Agent 卡同一枚 Bot）、派发的角色名和状态文字。角色名按名字着色，读不到时不显示，摘要行只留「子智能体」。运行态的扫光仍走兜底卡。
- 分享页与只读时间线同样按这个名字认领，不把 wire 名印给匿名分享读者。

## 所有者

- 工具名认领与角色名读取：`packages/ui/src/lib/subagentToolNames.ts`。工具名比对 `toolName` / `kind` / `title` / raw 里的 wire 名（抹掉大小写与分隔符）；角色名是工具输入里的 `agent`（流式半截 JSON 解析不出来就当没有）。
- 卡面：`packages/ui/src/ToolCallBlocks/renderers/subagent.tsx`，由 `resolveRenderer.ts` 在 family 分流之前认领。
- 文案：`chat.toolCall.kind.subagent`（中文「子智能体」/ 英文 `SubAgent`）。

## 失败

`picode_subagent` 不登记进 `packages/shared` 的已知工具表：登记成 `agent` family 后这张卡会落到 Agent 卡上，而 Agent 卡按 `subagent_type` 一类键读角色、且不渲染工具输出，于是派给谁和子智能体的回答都会消失。名字认领必须排在 family 分流之前，登记前后两种世界都要成立。

# 会话投影常驻

## 行为

- 会话内容属于 renderer 的内存投影，不属于当前显示它的页面。切视图或切到别的会话再切回来时，已经有过的内容必须原地可见，不能重新进入「加载会话」。
- 投影按 `conversation/<sessionId>` 存在数据层里，pane 通过租约引用；同 session 多 pane 共享同一份投影（只读多视图）。
- 租约在 commit 的布局阶段取得，不在 paint 之后的 passive effect 里取得。命中常驻投影时，新会话的内容在浏览器第一次绘制之前就已就位，`v4-history-loading` 占位不会被画出来。只有真正的冷订阅（首次打开该会话、投影已被淘汰、连接换代）允许出现这个占位。
- 常驻策略是「最近使用」而不是「最近 N 秒」：引用归零的投影进入空闲队列，队列超过 32 项才按最久未用收到 16 项，另有 30 分钟空闲上限。三个数字与 CLI session 常驻池（`session-resident-pool.ts`：target 16 / high water 32 / idle 30min）同标度。之前是「归零 30 秒就退订」，切走一会儿再回来就被判成冷订阅。
- 引用归零不等于停会话：退订只关视图订阅，CLI 里的 session 继续跑。被保活的投影继续收帧，所以切回来看到的是当前状态而不是旧快照。代价是常驻期（最多 30 分钟）内每个保活会话仍占一条活订阅并接收帧增量，上限就是 high water 的 32 条。
- 聊天区保活期间仍是完整子树，内部带 z-index 的元素会浮起来（输入区 dock、回到底部、状态面板都在 `z-10` 以上），所以聊天区自己必须是层叠上下文（`isolate`），否则它们会盖到待办/自动化页上、且 `pointer-events-auto` 的后代仍可点。
- 应用内主视图切到待办、自动化时不卸载聊天区：这两个页面以覆盖层盖在聊天区之上，聊天区保持挂载，用 `inert` + `pointer-events-none` 屏蔽交互，并把前台遥测判为不可见。设置页与插件商店本来就是常驻覆盖层。

## 所有者

- 投影内容的所有者：`conversationProjectionStore.ts`，一个 topic 一个实例。除诊断用的 `liveProjectionStores` 统计外没有第二份副本；`store/zcodeSessionStore*` 只存 task meta、runtime、权限弹窗等，不存 rows。
- 投影生命周期（引用计数、空闲队列、淘汰、退订）的所有者：`sessionDataLayer.ts`。pane 只持租约，不自行缓存或清理 rows。
- 连接（transport + 数据层）的所有者是 `workspaceConnectionRegistry.ts`，按 endpoint + workspaceIdentity 分桶，有自己的 keep-warm，与本节的同会话常驻互不影响。
- 当前主视图由 `app-shell/WorkspaceShellLayout.tsx` 的 `workspaceMainView` 决定。覆盖层与否不改变 pane 绑定：pane id 是稳定的 `workspace-main`，切会话只换 `sessionId` prop。

## 失败

- 常驻投影的重新订阅失败（CLI 重启后内存会话消失等）：落在 store 的 `status: "error"` 与 `retry()`，不进会话级错误 UI，也不在后台静默重试到成功。
- 淘汰时退订抛错：只记 warn 并丢弃该 store，不影响其它会话的投影。
- 覆盖层显示期间聊天区仍可能收到帧：这是预期行为。`inert` 只关交互，不冻结投影，也不停订阅。
- 跨 workspace tab 切换仍会卸载整棵 workspace 树，回来走 workspace 连接重建。这是显式选择（不同 workspace 的会话目录不同），不属于本节的保活范围。
