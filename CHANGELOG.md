# Changelog

## [3.21.1](https://github.com/Otherworldy/PiCode/compare/v3.21.0...v3.21.1) (2026-11-11)

### 新功能

* **i18n** 内置子智能体角色名按界面语言展示 ([4aaa386](https://github.com/Otherworldy/PiCode/commit/4aaa386a1e0e1d0d5cbd2809ba9c54181dffda5d))
  - 只翻内置角色。用户自建、插件角色和宿主兜底值（`subagent`）原样展示。
  - 词条缺失时回退 wire 名：`formatMessage` 缺 key 会把 id 原样打出来。
  - 子会话没有自己的标题时宿主拿角色名当标题，侧栏 tab 会显示成 `worker`；只有整串恰好等于内置角色名才翻译，任务标题是自由文本，不做词条匹配。
  - 存储的 title 一律保持 wire 名，翻译只在渲染时做——否则切语言后已经打开的 tab 不会跟着变。

* **i18n** 内置子智能体描述按界面语言展示 ([6477015](https://github.com/Otherworldy/PiCode/commit/6477015091f71f86db5a10b17159df1d6d3f5107))
  - subagentDisplayDescription 查 subagent.builtin.<name>.description，非内置角色与词条缺失时回退传入的原文
  - 接入设置页内置角色列表、/ 与 @ 提及列表（标签走展示名，描述走展示描述）
  - 搜索 haystack 收录 wire 名与展示名两侧的词
  - 提及条目的 value / markdown 仍是 wire 名，插入输入框的是真正的派发名
  - 测试遍历 BUILT_IN_SUBAGENTS，校验英文词条与源定义逐字一致

* **subagent** 调用时可指定模型与思考档位 ([8f49936](https://github.com/Otherworldy/PiCode/commit/8f49936b598e977632ab1d9dd829692c6d0505f3))
  - `model` 里带 `:档位`、或缺 provider/模型名 → 参数错误。
  - 模型目录里没有这个模型 → `subagent failed: model … is not available`，不回退。
  - `thought` 不在七档内 → 参数错误，不静默折成 `off`。
  - 七档内但目标模型的 `thinkingLevelMap` 没声明它 → 失败并列出支持的档位（`thought "minimal" is not supported by …; supported: low, high, max`），不交给 Pi 自己夹到相邻档。一个档都不支持时写 `supported: none`。


### 问题修复

* 上游请求头改为实际上报内置 Pi 版本 ([efad31d](https://github.com/Otherworldy/PiCode/commit/efad31deccdee6ae81bf97d548be7f8de1c0617e))
  - 不用 esbuild define：VERSION 在模块内已由 export const 声明，esbuild 对本地声明不做 define 替换（实测输出原样）
  - 改写合并进已有的 import.meta.url 插件：同一文件只有第一个返回内容的 onLoad 生效，单独注册会抢掉 config.js 的 fileURLToPath 改写，CJS 下 Module 初始化直接崩
  - 找不到原声明时构建抛错并给出文件路径，Pi 若改实现必须当场暴露，不允许静默退回 0.0.0

* **session-title** 总结模型不可用时不再静默改用对话模型 ([be1c070](https://github.com/Otherworldy/PiCode/commit/be1c07011ab779a99325307d5dd512e1486410e8))
  - completePiPrompt 增 missingModel 选项，默认仍走 null 契约，git commit message 等调用方不受影响；自动标题总结与右键手动总结传 throw，让两种事实分开。
  - requestSummarizedTitle 为每次候选失败、候选返回不可用各记一条 warn（带 provider/model 与原因），成功记一条 info 指明实际使用的模型，保留回退但不留静默分支。
  - 同步 SPEC：侧栏相位折算的适用范围，以及总结模型候选失败要可追踪。

* **session** 压缩与子代理运行期间侧栏照常显示运行中 ([6615bda](https://github.com/Otherworldy/PiCode/commit/6615bdada3aabff09acddec9ce5bcdade8951ff4))
  - 新增 deriveSessionRunPhase：control.activeWorks 里有 compact，或 backgroundWorks 里有 running 子代理时，把列表相位折算成 running。不回写 control.phase，canStop、队列推进与输入可用性仍按真实相位判定。
  - sessions-index 投影与打开中的 pane（livePhase）共用这个函数，两个数据源口径一致；后台 bash 不折算，error 仍为 error，失败点优先于转圈。
  - 补测试：projector 事件链覆盖空闲 compact 与活子代理的进出，投影派生覆盖 compact / subagent / 后台 bash 三种来源。

* **subagent** 后台结算通知画成工具卡 ([cffcf5c](https://github.com/Otherworldy/PiCode/commit/cffcf5ccb1f079401630c55ba2ddbe3c7abc5a5f))

* **subagent** 已结束子代理按结束时间倒序 ([ffc53d6](https://github.com/Otherworldy/PiCode/commit/ffc53d6b141168c7cebc31386cec99418fad0035))

* **v4** 记住的模型在目录改名后不再让输入框停在空选 ([fe197a4](https://github.com/Otherworldy/PiCode/commit/fe197a4dfdbd576b46dc4d43ccb0c813e45d9452))
  - 不做身份比对：account-plan 会被 resolveEffectiveModelSelection 改写到当前连接，按身份判失效会误覆盖本来可解析的选择
  - 已有会话先等会话快照再回退，否则 Host 默认会抢在会话真值之前占位；草稿未初始化与等待首次分享导入时不回退
  - 不补档位：回退值缺档位时仍要求用户显式选择，发送门禁语义不变
  - 回退链不读 localStorage，render 期零 IO

* **v4** 尾窗不再裁掉最后一轮的 turnHeader ([46d6ebd](https://github.com/Otherworldy/PiCode/commit/46d6ebddbe655e32f756b996b2b0648f3ca0cebf))
  - 下发侧新增 wireTailRows：最后 60 行外加最后一轮的 turnHeader 与首条 userInput，上限 62 行，不做任意扩张。增量可见性判定与字节预算改用同一函数，避免保底行上的 upsert 被当成窗口外行丢掉。
  - 客户端仅在没有 header 且是最后一轮时接受 sessionPhase === "running" 作为依据。有 header 时 header.state 仍是唯一权威，不覆盖计划审查、后台子代理收口时的 phase 分叉。

## [3.21.0](https://github.com/Otherworldy/PiCode/compare/v3.20.0...v3.21.0) (2026-11-07)

### 问题修复

* 补回 dev 启动暴露的编译期遗漏 ([4af05af](https://github.com/Otherworldy/PiCode/commit/4af05af5b59e5dceb316bae51a6f73b3fa3b7896))
  - synthetic-notice-metadata：workflow_launch 补回 user_prompt 映射。该来源的生产方已移除，但枚举值因读旧 transcript 保留，switch 缺 case 时 noImplicitReturns 报 TS2366
  - server.ts：删掉 checkPermission 的 workingDirectory 传参，PermissionContext 上的该字段已随 workflow 草稿免确认一并移除
  - build-desktop-agent-cli / mcp-apps-host-e2e：从构建清单移除已删除的 dynamic-workflow 与 dynamic-workflow-runtime
  - node-repl-host：同步 dist-types source map 的行号偏移

* 清理打包链路上对已删除 bundled-skills 的引用 ([6d909fb](https://github.com/Otherworldy/PiCode/commit/6d909fb8632ab65f064661bfd7067f20c3bfceb3))
  - scripts/prepare-prebuilds.mjs：远端 mock-cdn 的 stage 步骤
  - packages/desktop/scripts/prepare-agent-node-bundle.mjs：本机桌面包 stage
  - apps/zcode-cli/packages/cli：SEA 构建的资产收集（删除 sea-bundled-skill-assets.mjs 及其在 build-sea.mjs 的接线）

* **model** 生成中切换模型不生效 ([437f458](https://github.com/Otherworldy/PiCode/commit/437f4582ccb633c1bb84d400d4eb5373181f397e))
  - 模型切换是 last-write-wins，却按投影 revision 做 CAS：turn 进行中 control/row.* 会让 conversation revision 持续前进，用户的切换意图按 proto.staleRevision 被丢弃。移出 COMMANDS_REQUIRING_BASE_REVISION。
  - handler 只调 setModel 就回 accepted：setModel 后校验 runtime Selection，目标身份未变时以 model.notApplied 失败上行。
  - pi-host 的同值判定与 getSessionModelSelection 读投影 config 而不是 Pi 事实，投影一旦脱节就永久 noop；pi.setModel 返回 false 也被静默 return。改为读 session.model（currentModel 由创建时快照改成活值 getter），不可解析时抛 model.notInRuntime。

### 重构

* 移除工作流功能 ([c753448](https://github.com/Otherworldy/PiCode/commit/c7534486b26dc207fbcdeeb3dcac722e72ea646d))
  - 独立包 @zcode/dynamic-workflow 与 @zcode/dynamic-workflow-runtime
  - 12 个工作流工具（CreateWorkflow / AmendWorkflow / SaveWorkflow / ListSavedWorkflows / EvalWorkflowSnippet / ListWorkflowRuns / GetWorkflowRun / ResumeWorkflowRun / ResolveWorkflowQuestion / ListModels / submit_result / escalate）
  - 3 条命令（resumeWorkflowRun / startSavedWorkflow / amendWorkflowRunSettings）
  - v4 协议的 workflowRuns 状态键、workflowRun.* 增量与 7 条查询路由
  - UI 侧板、时间线、因果图、saved-workflows 页、workflow-studio
  - 自动化页的工作流标签页，现只剩定时任务 / 闲时任务
  - CLI 的 --enable-workflow、/workflow、/expert、/dwf 与 __zcode-dwf-child
  - 内置 dynamic-workflows 技能包

## [3.20.0](https://github.com/Otherworldy/PiCode/compare/v3.19.6...v3.20.0) (2026-11-03)

### 新功能

* **memory:** 工作区记忆改为项目级存储并迁移到侧栏项目菜单 ([6d28d90](https://github.com/Otherworldy/PiCode/commit/6d28d904c56338564aa591a97e38af9af0bd5cd0))
  - 记忆存放在 <workspace>/.pi/memory，MEMORY.md 作索引，单条记忆一个 .md
  - 开关改为 zcode.json features.memory，默认关闭；远端工作区不注入、不抽取
  - 新增项目级抽取模型 features.memoryModel，留空跟随会话模型
  - 侧栏项目菜单新增「项目记忆」，支持查看、新建、编辑、删除
  - 注入改用 forceSystemPrompt 追加，抽取在 agent_end 后旁路执行

* **memory:** 记忆加入语义 frontmatter、过期清理与有界抽取修正 ([a8b924f](https://github.com/Otherworldy/PiCode/commit/a8b924f824356cb2ff6d5f19c4e426edd8b2efb5))
  - 游标：memoryExtractionCursor 记录上次成功抽取覆盖的最后一个 turnId，
  - 索引对账：reconcileWorkspaceMemoryIndex 剔除死链、按 frontmatter 补孤儿
  - 热开启：注入扩展改按「能力位」（本地且非侧聊/远端）注册，开关由 getter
  - prompt 增加必填字段与禁止清单（临时任务状态、仓库已记录的事实、会话内短期

* **memory:** 默认不按闲置时间清理，只按 expires 到期 ([9102806](https://github.com/Otherworldy/PiCode/commit/9102806b84f7e95dae5e87350462d3abec33186c))

* **memory:** 项目配置迁到 .pi/picode.json，记忆抽取改为有界输入 ([3a7365b](https://github.com/Otherworldy/PiCode/commit/3a7365bf82159c3879d918d4dbd7c3c7eb2ebc89))
  - 新增 packages/shared/src/node/workspaceConfig.ts，项目配置统一落在 <workspace>/.pi/picode.json
  - 旧根目录 zcode.json 在读取时一次性复制到新路径，旧文件保留；写入前先迁移
  - workspace hooks 的发现候选路径同步改到 .pi/picode.json，configFileKind 新增 picode.json
  - 抽取 prompt 的现有记忆部分改成 manifest：文件名 + description + 前 30 行预览，
  - 预览被截断的文件禁止整份重写，新增 appends 字段供追加
  - MEMORY.md 注入改为 200 行 / 25000 字符截断 + WARNING，不再整份丢弃
  - 读取上限放宽到 1 MiB，超预算的模型索引不落盘，改重建紧凑索引
  - 距上次抽取满 3 个 turn 或满 10 分钟才允许下一次
  - 本轮主模型已写记忆则跳过抽取；无真实用户散文（< 3 词）的轮次不抽

* **memory:** 主模型直写记忆后归一 frontmatter 并补索引行 ([5b9ae3a](https://github.com/Otherworldy/PiCode/commit/5b9ae3ad99d531439eaa1d89402c3617e8760f87))
  - shared 新增 normalizeWorkspaceMemoryItem：只补/改 frontmatter 的 8 个规范字段，
  - 记忆扩展挂 tool_result 钩子，只处理 .pi/memory/<item>.md；落盘后对账补指针行。
  - 抽取开始前先对账索引，再读 MEMORY.md 与 manifest：否则主模型刚写、还没进索引的

* **ui:** 待办统一状态图形，头部改为按状态分段计数 ([74256bd](https://github.com/Otherworldy/PiCode/commit/74256bd5e43448eced69aed5f00d874d79ab96ec))
  - 新增 packages/ui/src/components/TodoStepGlyph.tsx 作为唯一实现：完成=实心绿盘白勾，
  - 进行中的弧用正文色、轨道降到 0.2 不透明度，比待办的灰环更重；减少动效时停在静态弧上，
  - 图形带 role="img" + aria-label（已完成/进行中/未开始），状态不再只靠颜色和删除线
  - in_progress（ZCodePlanStep）与 inProgress（V4 PlanItem）由组件同时接受，调用方不转写
  - 删掉三份重复的 TodoStatusIcon / todoTextClasses，以及状态面板的 PlanStatusIcon
  - 状态面板区块标题「进程」改为「待办」，右侧从 2/5 换成「已完成 N · 进行中 N ·
  - 输入框待办抽屉收起时，在展开箭头后显示当前步骤的状态点；ComposerTodoModel 新增
  - stripTodoStepEmphasis 去掉行内成对的 **…** 和 __…__。加粗对里不允许再出现 *，
  - 工具卡标题、探索子行、摘要胶囊同样清洗；纯展示，不写回快照和工具输出

* **ui:** 项目记忆弹窗可视化配置过期阈值并显示分类 ([cb4a513](https://github.com/Otherworldy/PiCode/commit/cb4a5133801e618cb2426ced32fb8598c02e080d))
  - 新增 WorkspaceMemoryExpirySelect：预设 7/30/90/180/365 天 +「不按闲置清理」。
  - 记忆列表在文件名右侧显示 frontmatter 的 category 标记。
  - 三项项目级配置（开关/抽取模型/过期阈值）的「乐观更新 + 失败回滚 + 打开时重读」


### 问题修复

* 远端 Built-in 配置与 Pi 1.5 MCP OAuth 的协议兼容 ([8437a19](https://github.com/Otherworldy/PiCode/commit/8437a19a48ed76c2d0948346862b39ed195adc26))
  - zhipuAccountModeDataSchema 与 zcodeProviderAccountAccessSchema 补 highspeed。
  - 派生代理 Provider（off-peak / highspeed）不参与三套餐可用性查询：
  - 协议 MCP OAuth schema 补 clientRegistration（auto/dcr/cimd）。

* **memory:** 抽取写入也按契约归一，重复 frontmatter 键只留一行 ([aebc097](https://github.com/Otherworldy/PiCode/commit/aebc097899e392a3c6c894c01aa120533723f490))
  - normalizeWorkspaceMemoryItem 对已知键去重，值取最后一次（模型常见笔误），
  - applyWorkspaceMemoryPatch 在写 writes 之前跑同一个归一：重复键、漏字段、
  - spec 补这条归一范围与场景 42。

* **memory:** 空 patch 算抽取成功，截断与迟到 turn 立即续抽 ([76eee76](https://github.com/Otherworldy/PiCode/commit/76eee763da6cc7e437dffb6febff195936d9584a))
  - 空更新（`{}` 或三个数组都空）不再判成解析失败：prompt 明确允许模型对「这轮没有
  - 抽取成功后若游标后面还有 turn（本轮被截断，或抽取期间又来了新 turn），绕过频率
  - 单个 turn 自己超 24k 时仍只喂前 24k，但返回 oversizedTurnId 并记 warn，让丢掉的部分
  - 直接写入归一后无条件对账索引：文件 frontmatter 已合规（changed=false）时也要补指针行，
  - 顺手删掉 write 测试里未使用的 resolve 导入。
  - spec 补空更新、续抽、超大 turn 的可观测性，加场景 38–41 与 worktree / 条目版本等已知边界。

* **memory:** 热开关、门禁区间与截断游标按实时状态判定 ([35e5975](https://github.com/Otherworldy/PiCode/commit/35e59750664a5850d39fd811e1cb3e45a3b886a8))
  - 开关只有 .pi/picode.json 一个事实源：注入、抽取调度、写记忆免确认各自在用到时
  - 抽取门禁、transcript 与游标共用同一份游标切片；直接写入门禁收窄到刚结束的
  - transcript 按 turn 从区间开头拼，超 24k 停在断点并返回 coveredUntilTurnId，
  - 索引缺失但磁盘已有条目时按条目生成索引；抽取 prompt 注入当天日期。
  - 抽取模型只有“模型不存在”才回退会话模型；patch 部分跳过时记 warn 且不乱推游标。

* **memory:** 项目记忆弹窗对齐设置页控件与全站确认框 ([284306b](https://github.com/Otherworldy/PiCode/commit/284306bb063353ebd685c004f10dfbd45d76461b))
  - 三项设置改用 SettingsGroupCard + SettingsRow，控件统一 size="lg"，
  - 删除记忆文件和放弃未保存修改改用全站 useConfirmDialog
  - 编辑器文件名输入 size="lg"，正文编辑框换成设置页的 input 边框/底色 token。
  - 条目计数不再把“尚未创建”的索引占位行算成一条记忆。

* UI 设计模式的审查 done 后自动关掉模式 ([54dcebb](https://github.com/Otherworldy/PiCode/commit/54dcebb4f6eeb90e8f4e3350bc3f0007b99a032b))
  - 配对只认模型在模式内调用 `annotate` 成功的那一次；任一条 annotate 收口
  - `setUiDesignMode` 的实现提成 `applyUiDesignMode`，UI 命令和自动关闭共用同
  - 已知边界：插件批注路径不发通知（直接发 follow-up 消息），那次配对会留到

* **v4:** 关掉的扩展命令回执不再随切会话重新弹出 ([28a972b](https://github.com/Otherworldy/PiCode/commit/28a972b91c46be58e32bc80b04adaaafb8e358df))
  - 新增 V4 命令 dismissExtensionNotice：快照是回执的唯一所有者，关掉要交回宿主；
  - 宿主清空快照同时清掉扩展命令的累积镜像，命令还在跑时之后的 notify 另开一个
  - 弹窗关闭先本地乐观收起再发命令，被拒或传输失败只记 debug，不重开
  - pi-host 单测覆盖：清空增量确实投递、重复关闭幂等、同一命令后续输出换新 id、


### 杂项

* **pi:** 升级内嵌 Pi SDK 到 1.5.0 ([d482de4](https://github.com/Otherworldy/PiCode/commit/d482de460a93bc22cfe530a61665ff2d5bc7aa27))
  - pi-ai / pi-coding-agent / pi-mcp 由 1.4.0 提到 1.5.0，新增传递依赖 pi-schema
  - 已核对本仓库未使用 TypeBox 扩展能力，工具参数改用 pi-schema 校验后
  - CreateAgentSessionOptions / AgentSession / SettingsManager / PackageManager


### 文档

* **memory:** 去掉 spec 与测试里因分批暂存产生的重复段落 ([43b8493](https://github.com/Otherworldy/PiCode/commit/43b8493dbc90b095481348d1bcefc4ee72c245fc))


### 重构

* **memory:** 删除 apps/zcode-cli 旧工作区记忆栈 ([f8b3d99](https://github.com/Otherworldy/PiCode/commit/f8b3d99d25e2ff0df57e7834aa40fd131d326e2d))
  - core/src/memory/{extraction,memory-agent-loop,index-content,directory,
  - core/src/runtime/helpers/project-memory{,-agent,-extraction}.ts
  - core/src/subagent/persistent-memory{,-prompt}.ts
  - core/src/tool/executor/memory-file-permission.ts
  - core/src/context/sections/memory.ts（零消费者的旧注入段）

## [3.19.6](https://github.com/Otherworldy/PiCode/compare/v3.19.5...v3.19.6) (2026-10-30)

### 新功能

* **ssh:** 远程连接支持 SOCKS5 与 HTTP CONNECT 代理 ([f4fada1](https://github.com/Otherworldy/PiCode/commit/f4fada103984825e87e2a9946d883a1ecd7517a2))
  - Host 进程内建本地转发器（127.0.0.1 随机端口）完成 SOCKS5（含用户名密码
  - ssh/scp 走代理时改连本地端口，远端主机名只留给 HostKeyAlias：known_hosts
  - 代理口令与 SSH 口令同一套：0600 私有文件 + spec 只带路径，历史快照只存
  - 向导新增选填代理区（类型/地址/端口/用户名/密码），脏端点只丢字段退回直连
  - validation 的 sshConnectOptionsSchema 补 proxy 字段：Zod 会剥离未声明字段，


### 问题修复

* **v4:** 回退到此处后输入框的图片/视频附件仍显示缩略图 ([72f5075](https://github.com/Otherworldy/PiCode/commit/72f507593162e90f0909678bfdaf049cffc476ef))

* **v4:** process 通知按状态行折进工作块，不再切开时间线 ([874f07a](https://github.com/Otherworldy/PiCode/commit/874f07afac598fa31b8693c508a71230f99b1c88))

## [3.19.5](https://github.com/Otherworldy/PiCode/compare/v3.19.4...v3.19.5) (2026-10-29)

### 新功能

* **desktop:** 摸鱼正文可调字号、行距和字间距 ([b7e5ed7](https://github.com/Otherworldy/PiCode/commit/b7e5ed74091a0acfb2a3096af116760308325043))

## [3.19.4](https://github.com/Otherworldy/PiCode/compare/v3.19.3...v3.19.4) (2026-10-29)

### 新功能

* **models:** 拉取模型改为先选择再导入 ([acba911](https://github.com/Otherworldy/PiCode/commit/acba911596316a4dce87793a07a05dd555e87e47))
  - 可添加项超过 20 个时默认只选前 5 个，避免一次导入把模型菜单淹没
  - 已添加行保留展示并禁用勾选，不参与全选三态
  - 搜索与「只看未添加」只改可见性，不改已选集合
  - discover 结果按连接字段做请求级缓存，与「测试连接」共享

* **subagent:** 子代理支持后台派发 ([2d21485](https://github.com/Otherworldy/PiCode/commit/2d214853c51109786afcff34a0007d9065f04f03))
  - 后台派发由每会话一个 runner 管：并发上限 6、占位到真实 id 的交接、恰好一次
  - 结果走 `sendCustomMessage({ triggerTurn, deliverAs: "followUp" })`；
  - 工具结果带 `details.backgrounded`，工具卡摘要行显示「后台」角标
  - 后台分支不绑父工具的 AbortSignal；`session.abort()` 在首轮 prompt 之前是


### 重构

* 移除遥测系统 ([2cbb1ba](https://github.com/Otherworldy/PiCode/commit/2cbb1ba04544367934b27bbce902906cec97352c))
  - `V4_NOTIFICATIONS` 移除 `conversationTelemetryFact`、`localTtftFacts`
  - 新增 `v4/turn/lifecycle`，只携带 sessionId 与终态，供
  - `zcode-protocol` 移除 4 个遥测通知及 `zcodeMcpTelemetry*`、
  - `packages/ui/src/lib/*telemetry*`（22 个）、`v4/telemetry/`
  - `packages/services`：`telemetryCore`、`conversation-telemetry/`、
  - `packages/desktop`：9 个 `host*Telemetry`、ARMS RUM bootstrap、
  - `packages/shared`：`telemetry`、`telemetryRedaction`、
  - `packages/rpc`：`network-telemetry-middleware`
  - `apps/zcode-cli/packages/telemetry`（整包）
  - `adapters/src/exec/bash-resource-telemetry`
  - `deviceMid`：仍作为模型 API 与错峰服务请求头，磁盘文件名
  - 资源管理器：新建 `adapters/src/mcp/process-registry.ts` 承接
  - 会话统计 TTFT：进程内单调测量，链路未受影响
  - `ModelStatusSink` 的 `admissionTicket` / `requestStatusSink`
  - `runtimeEnv.ts` 的 `OTEL_*` / `ZCODE_TELEMETRY_*` 剔除名单：
  - 模型错误归因从遥测命名空间迁至
  - 依赖移除 `@arms/rum-electron`（含 patch）、6 个 `@opentelemetry/*`、
  - `SkillTelemetryMetadata` 整链删除；`turn.started`/`turn.terminal`

## [3.19.3](https://github.com/Otherworldy/PiCode/compare/v3.19.2...v3.19.3) (2026-10-27)

### 问题修复

* **ui-design:** UI 设计模式稳定拿到 plannotator 工具 ([d4166b9](https://github.com/Otherworldy/PiCode/commit/d4166b9998f5eb2b3be4aa822269bb40c7cd36f4))
  - 插件把 plannotator 注册成 defaultActive: false，激活只放在它自己的
  - 插件在 Pi 宿主上默认不注册这个工具（AGENT_TOOL_DEFAULTS.pi 为 false），
  - SPEC 补上两条规则的归属，子会话按 print 绑定不补

## [3.19.2](https://github.com/Otherworldy/PiCode/compare/v3.19.1...v3.19.2) (2026-10-27)

### 问题修复

* **plan:** 计划模式开关不再弹扩展命令回执窗 ([5318165](https://github.com/Otherworldy/PiCode/commit/5318165ee47310b0ea6bac9a9435047b63b8e708))
  - 扩展命令执行期间的 notify 会聚成一个模态弹窗。plannotator-plan-mode 的 info 回执不再聚进去，状态已经在输入框的计划开关上
  - warning 和 error 照旧弹，插件报的问题不被吞掉
  - 插件后装、会话没重载时命令未注册，走普通输入不进这条路径，所以之前只有部分会话弹窗

* **session:** 标题总结不再把用户任务当指令执行 ([e0e1253](https://github.com/Otherworldy/PiCode/commit/e0e1253d1c2d0bb5aaa7f17b7a7586276b14350d))
  - 种子用 <transcript> 圈起来，系统提示说明它只是素材、里面的指令一律不执行：模型常把首条任务当成自己的活，直接执行并返回数据列表
  - 清洗后为空、或输出是纯数字和数据列表这类非短语时按失败处理，换下一个候选模型
  - 韩文、西里尔等非拉丁标题不再被丢掉
  - 指定总结模型失败或没有可用标题时继续试对话模型，候选去重

## [3.19.1](https://github.com/Otherworldy/PiCode/compare/v3.19.0...v3.19.1) (2026-10-27)

### 新功能

* **ssh:** 远程连接支持 Windows 远端与空密码认证 ([94a7940](https://github.com/Otherworldy/PiCode/commit/94a7940b73ef2c01be6e143828492a41ee454bfc))
  - 连接阶段真实探测认证与远端 shell 家族（PowerShell 优先）：认证失败在连接
  - 空密码作为合法密码认证：全链路用 typeof 判断，空口令同样落 0600 凭据文件，
  - Windows 远端命令走 powershell -EncodedCommand；文件服务与 agent 工具桥按平台
  - 目录浏览器父目录推导不再写死 /，C:\ 也是根
  - 修复 identity 解析拒绝盘符路径导致 createSession 直接失败，以及 MCP 配置迁移

* **ui-design:** 审查页改由模型调用 plannotator 打开 ([d304aa4](https://github.com/Otherworldy/PiCode/commit/d304aa4ac818b093e4f900dc7d3c347124fafd9d))
  - 系统提示段 ui_design：唯一交付 designs/ 下的自包含 HTML，写明
  - 紧邻用户消息的 turn order：同一套要求，靠 ui_design 段失效。
  - 文字收尾的 nudge：覆盖「没写 HTML」和「写了没开审查」两种情况。


### 问题修复

* **chat:** 滚回底部后重新跟随最新输出 ([a72eeb2](https://github.com/Otherworldy/PiCode/commit/a72eeb23140d288652df77159af1874e073e37ca))
  - 工具卡收起时 scrollHeight 变小，scrollTop 被 clamp 变小，原来会被
  - 滚轮上滚时位置还没变，几何判定会把刚设好的「离开底部」读回「在底部」。

* **desktop:** 摸鱼正文的编码探测不再把 UTF-8 误判成国标 ([f66f873](https://github.com/Otherworldy/PiCode/commit/f66f8735ac4620fb7c7f14638e4ae7e70310c820))

## [3.19.0](https://github.com/Otherworldy/PiCode/compare/v3.18.1...v3.19.0) (2026-10-25)

### 新功能

* **chat:** 回退到此处可撤销消息之后的文件改动 ([aa7b242](https://github.com/Otherworldy/PiCode/commit/aa7b2422c3cf1daba549e579d52e903473150729))
  - 回退前预检锚点及之后所有 turn 的文件改动，弹确认框选「只回退对话」或「撤销文件并回退」
  - 文件撤销与对话裁切合并进同一条 editUserQuery，避免两条 CAS 命令踩 revision
  - core 按 active chain、Pi host 按投影窗口各实现 suffix 展开；覆盖已有文件的 Write 判为不可撤销
  - 确认框沿用 Dialog 默认规格，宽度与项目确认弹窗一致

* **sidebar:** 项目支持重命名，改名弹窗与其它对话框对齐 ([64b886e](https://github.com/Otherworldy/PiCode/commit/64b886e7ed4d839f5b68be0a3aa5459f53901e31))
  - 侧栏「更多」菜单新增「重命名项目」，本地和远程项目都可用，只改显示名，不动路径、身份和连接目标
  - 显示名优先级 自定义名 → SSH 主机名 → 目录名，侧栏、拖拽预览、顶栏、命令面板、任务归属、空态项目菜单、文件树、手机工作区列表、插件作用域、自动化候选统一走同一解析
  - 随 lastWorkspaceSession 持久化：恢复、重连、首帧补齐都不会丢自定义名，清空改名也不会在重启后复活旧名
  - 侧栏菜单打开改名弹窗时显式收起菜单，避免下拉和弹框同时停留
  - 改名弹窗统一到 max-w-3xl、标题 18px、输入框与按钮同高 40
  - 补 testid 与 vitest：显示名解析/归一化/持久化映射、store 改名与恢复优先级

* **subagents:** 子智能体内置工具清单可配置 ([886cf32](https://github.com/Otherworldy/PiCode/commit/886cf32b7b335dc932a4316cf7ae97dffababd6f))
  - Pi host 暴露运行时可用工具清单，bootstrap 经 agent-tool-catalog 转成可选项目
  - 子智能体 profile 支持 builtInToolOverrides，设置页按角色勾选或恢复默认
  - pi SDK 升级到 1.4.0

* **ui:** 工作块运行中的动作标题按工具分类并轮换文案 ([b17715f](https://github.com/Otherworldy/PiCode/commit/b17715f686b28458b1a34f118b1cf51fe932ca3d))


### 问题修复

* **agent:** 工作区事件帧与交互回执按工作区回收 ([a4c00a4](https://github.com/Otherworldy/PiCode/commit/a4c00a41592c34338b8733516743cac943106337))
  - getOrCreateWorkspaceEmitter / fireWorkspaceFrame 的 emitter 表原来只增不减：
  - userInput.resolved 回执要同时查两张表（resolved 与 pending），否则解析后

* **browser:** 下载监听与录制 Session 不再泄漏 ([fda8639](https://github.com/Otherworldy/PiCode/commit/fda86399269a3b956f43c53279883e089ebcd981))
  - setupDownloadTracking 的 will-download 监听挂在 session 上，guest 销毁后
  - 录制 session 原来每次录制都用 fromPartition(zcode-browser-video-recorder-${uuid})：
  - Playwright executor 补上页面上下文需要的 DOM 类型声明（main 工程不带 dom

* **cli:** stdio 按行切分，drain 以 bufferedAmount 为准并有上限 ([6c7ba49](https://github.com/Otherworldy/PiCode/commit/6c7ba491f7f0d5a0c99d3d3e214fa17a28f88c13))
  - 原来按 chunk 直接 split("\n")：一个 UTF-8 多字节字符被切在两个 chunk 之间
  - drain() 改成轮询 bufferedAmount（ws 没有 bufferedamountlow 事件），16ms
  - 手机远控链路同步改成同样的轮询语义，不再伪造「已经排空」的信号。

* **config:** cli/config.json 收敛为单一带锁写者 ([dc84560](https://github.com/Otherworldy/PiCode/commit/dc845607588caf5c7e6f2c8b9965301698a7d60c))
  - 新增 userCliConfigFile.ts：updateJsonConfigFile 用文件锁串行化读改写。
  - 写入路径的读取必须严格：只有 ENOENT 当空文件，其它错误直接抛，避免把损坏的
  - 路径解析改为函数而不是模块级常量：ensureAppDataDir 的 .zcode→.PiCode 迁移
  - pluginSyncService 的 addPluginDirToUserConfig 原来用本地 writeJsonFileAtomic

* **desktop:** 宠物包下载的写盘错误不再打死 main 进程 ([d6e51e6](https://github.com/Otherworldy/PiCode/commit/d6e51e6eac03787466ec7d16f79bdfe76a738bbe))

* **desktop:** 手机远控配对 cookie 持久 30 天，失效时给可读提示 ([560305a](https://github.com/Otherworldy/PiCode/commit/560305a30cc858a922b702a443fa4e9ed1a8ec87))
  - 配对 cookie 加 Max-Age=30 天，回到手机不用再回桌面重新扫码。局域网是明文
  - 口令对不上时，浏览器导航请求返回一页可读提示（配对已失效，回桌面重新扫码）；
  - 顺手修掉畸形 cookie 让 decodeURIComponent 抛 URIError 的问题。异常冒到 Main

* **desktop:** 远程连接超时、采样 latch 与沙箱生命周期 ([4401e10](https://github.com/Otherworldy/PiCode/commit/4401e109fbb8ee18c0d92209a4c20e71385c3b38))
  - ConnectRemote 原来没有任何定时器：对端不响应时 PendingConnect 永久挂着。
  - resourceManagerHostSampling 的超时回调只 resolve 不摘 requestIdByHost，
  - 沙箱按文档的五个生命周期阶段收口：clearing 用 try/finally，guestPolicy

* **memory:** 给缓存与额度加界，限制单次读取量 ([e3fd2bd](https://github.com/Otherworldy/PiCode/commit/e3fd2bd14317d5cc5363a94b94f91b66ae0649ac))
  - shiki tokensCache 加 LRU（200 条 / 8MiB 总量 / 单条 200k）。
  - plugin-ui 实例、gen-ui stateStorage、taskQueryCache、sessionWorktree 缓存、
  - pi-host projector 终态后不再保留完整 inputText（row.inputText 已有）；
  - MCP UI 调用加 per-instance 4 并发 / per-session 500 次 / 120s 超时；
  - taskRealtimeBus 分片改 netstring 长度前缀（原来 O(K²) stringify）；
  - proxyFetch 的 agent 表加界，超额时 close 而不是只从表里删（否则连接池继续
  - 日志写入改 WriteStream，hostLogRelay 保留 2000 条。

* **memory:** 遥测队列与 gen-ui 派生缓存不再无界增长 ([d7b18bd](https://github.com/Otherworldy/PiCode/commit/d7b18bd73bfcd691cc291f9f467d5288c7ea0e97))

* **pi-host:** 扩展命令的作废状态不再漏到之后的工具提问 ([bf68ad5](https://github.com/Otherworldy/PiCode/commit/bf68ad581f15e616eb0f0e34e1e1cc3815400647))
  - 只有扩展命令跑着（depth > 0）时，停止才作废这次命令剩下的提问。
  - 嵌套命令按帧保存外层 dismissed，内层结束不把外层的决定带脏。
  - handleUi 只在命令内因 dismissed 静默取消；命令外（工具发起的提问）照常弹。
  - depth 用 Math.max(0, ...) 收口，避免重复结束把计数压成负数。
  - 补三个场景：普通轮次停止不吞后续提问、命令结束后不再吞、命令内停止只取消

* **remote:** SSH 密码认证可用，目录浏览器默认打开远端 home ([66c61df](https://github.com/Otherworldy/PiCode/commit/66c61dfc16c20103a628207f46563c697331bdb6))
  - 密码不再只在 UI 里：Host 写入 0600 私有凭据文件，spec / agent spawn env / 子进程只带路径，askpass 从文件读口令
  - 有密码时改 BatchMode=no 并走 password,keyboard-interactive；askpass 形态按 ssh -V 判定 .cmd 或 sh 脚本
  - 主机密钥统一 TOFU（StrictHostKeyChecking=accept-new），指纹变化仍然拒绝
  - 目录浏览器起始目录探测远端 $HOME，失败回退 /www/wwwroot、/var/www、/opt、/srv、/home，最后回 /
  - 修 child.stdin EPIPE 未捕获、signal 已 abort 时子进程不被杀
  - bind 用 Host 内部未脱敏 target 重建 spec，避免脱敏快照覆盖 agent 侧凭据

* **rpc:** 限制单帧大小，隔离单次调用错误，按连接回收资源 ([dbcc637](https://github.com/Otherworldy/PiCode/commit/dbcc637832453bcdaacfe315e7631ed0093daaad))
  - 帧上限 MAX_FRAME_BYTES = 64MiB：超出直接断开，避免一条畸形长度头就把
  - 单次 RPC 抛错不再影响同连接上的其它调用：错误只回给发起方，连接保持可用。
  - host/index.ts 按连接包装服务：记录本连接创建的 terminal id，连接 dispose 时
  - docker-backend 的 dispose 只 kill 已证明归属的子进程，绝不 terminate 容器。

* **startup:** 存储启动等待加进度看门狗，不再永久挂起 ([d105ad1](https://github.com/Otherworldy/PiCode/commit/d105ad11f8010e920cb0186911a1b5525956f332))
  - 新增 createProgressWatchdog(firstFrameTimeoutMs, stallTimeoutMs)：首帧 30s、
  - zcodeStorageStartupGate 每帧续期；waiting_for_lock 暂停计时（锁等待有独立的
  - gate 失败后 zcodeProtocolClient 主动 rejectAll：本地 fail 不走 handleMessage，
  - 存储 worker 的 failed 终态帧也要喂看门狗（上一帧若是 waiting_for_lock，
  - worker.terminate() 抢占不了 node:sqlite 的同步原生调用，超时后直接 reject

* **todo:** 兼容旧库列名，后台对齐失败不再杀死 Host ([8153589](https://github.com/Otherworldy/PiCode/commit/81535899c6cca00b36c77eb722f3aa6760eb0cc4))
  - 新增 todoSchemaCompat.ts：补列并回填旧值（session_id ← last_session_id、
  - alignTodos 加 catch + warn，一次后台对齐失败只丢一条日志。

* **ui:** 文件搜索 Worker 崩溃后真正降级到主线程 ([0ecb93b](https://github.com/Otherworldy/PiCode/commit/0ecb93bf31a48b63c30b881204f40a017cfbf0b6))


### 杂项

* 忽略 pi-host 编译产物，清理无用导入与类型配置 ([2af3878](https://github.com/Otherworldy/PiCode/commit/2af3878206539df449ce3b70f562c29636d7f521))
  - build-desktop-agent-cli 会在 pi-host/src 下生成 .js/.d.ts/.map，这些文件
  - 删除 desktopCommandHandlers / desktopHostProcess 里已不用的 import。
  - 补齐 main 进程 typecheck 配置与 browser-perf-probe 的类型声明。
  - AboutSettingsSection 加 max-lines 豁免（各分区共享同一份版本快照）。


### 重构

* **ui:** 移除 onboarding 引导、办公模式与主动推荐 ([190d656](https://github.com/Otherworldy/PiCode/commit/190d656427bcb30de187b3540c3db683e7c906fc))
  - 删除引导流程、设置同步、办公模式与草稿主动推荐入口及相关 i18n
  - 清理 isOfficeMode / interfaceMode / toggleInterfaceMode 等跨包引用
  - 工作区插件排序去掉办公模式维度
  - 修正 ConversationTimeline 与下载进度文案的遗留类型错误

## [3.18.1](https://github.com/Otherworldy/PiCode/compare/v3.18.0...v3.18.1) (2026-10-21)

### 新功能

* **desktop:** 按住摸鱼自动翻页，宠物窗口按角色形状裁剪命中区 ([1e6dbe1](https://github.com/Otherworldy/PiCode/commit/1e6dbe1e25d88429766002c60e032508ea3e1e19))
  - 自动翻页：按住模式可开关，速率按每行毫秒数自由填（200–20000，缺省 1200）。
  - 窗口形状：用 setShape 把窗口裁到角色和气泡两块矩形，形状外不绘制也不收事件。
  - 修设置白名单漏字段：只改自动翻页时整条 patch 被丢弃，开关看起来打开却不生效。


### 问题修复

* **desktop:** 更新安装期间保留可见进度窗口 ([d1999ae](https://github.com/Otherworldy/PiCode/commit/d1999ae03e781944d1620efc2eede40be2af2df8))

## [3.18.0](https://github.com/Otherworldy/PiCode/compare/v3.17.0...v3.18.0) (2026-10-21)

### 新功能

* **chat:** 工作块标题按当前动作展示，结束时报用时与调用次数 ([85affbb](https://github.com/Otherworldy/PiCode/commit/85affbb81859f69a788c06aa2d2eb20bcefe3778))

* **chat:** 回退与分叉共用一套续接动作列表 ([8aa2cc2](https://github.com/Otherworldy/PiCode/commit/8aa2cc29b2829ec8cad94b3de18c71d6fff26c8d))

* **chat:** 轮尾展示本轮用量，工时只算干活时间 ([7150485](https://github.com/Otherworldy/PiCode/commit/7150485be76a2e617a1ad9e78a145abd9122236d))
  - turnHeader 新增 usage：pi-host 从 Pi 的 message_end 读 token 与
  - 缓存命中率按 cacheRead / (input + cacheRead + cacheWrite)。Pi 的
  - 吐字速度只算解码时间，扣掉首 token 等待；一次调用缺时长就整轮不给，
  - 失败、中断、deferred 回填的调用 usage 全零，整次跳过：否则一次超时
  - 轮尾操作栏改成常显，用量 pill 跟在复制/反馈/分叉之后，点击弹明细；
  - activeMs 改成净工作时间：权限审批、ask_user_question 提问、hook 审核
  - 并发等待合并成一段，后到的请求不截断先到的；resolved 丢失时由工具
  - waitedMs 只报已结束的等待，进行中的那段由 waitingSince 单独表达，
  - 「工作中」改成「工作中，用时 54 秒」，带扫光动画，用时与折叠标题同口径
  - pi-host 全量测试 222 通过；turn-usage 15 个、turn-wait-clock 9 个、
  - typecheck 与改动前基线一致（3 个既有错误，均在未改动的文件）
  - architecture:check --changed 0 违规

* **chat:** 输入框下方展示会话统计，插件状态入口下移 ([e0b299f](https://github.com/Otherworldy/PiCode/commit/e0b299f2dabfc348938b81292bd6048412b7c81b))
  - 新增 turns/steps 与 llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens，
  - 一步 = 一次产生用量的模型调用；零用量的失败/中断/冷恢复占位事件不计步
  - 时间指标只累加真实可得的时长：模型用时取 durationMs，解码段是总时长减

* **desktop:** 宠物窗口裁到角色区域，新增显示大小与裁剪开关 ([c286d22](https://github.com/Otherworldy/PiCode/commit/c286d2218b8a65594443c1abb0d0ff41d102429b))
  - 渲染端每段动画量一次角色不透明像素框，窗口和可点/可拖区域贴着角色，不再包含视频自带的透明留白
  - 量到的框缓存到 pets/box.json，重启直接按它建窗口
  - 新增 desktopPetDisplayScale（50%–150%）与 desktopPetCropCharacter（默认开启）
  - 气泡定位改为按角色顶边在舞台里的比例计算

* **desktop:** 宠物舞台支持自由裁剪，修保存后窗口跳位和设置行断行 ([67cf56e](https://github.com/Otherworldy/PiCode/commit/67cf56e819d07992058574e7ee8c2fb7dd22a70a))
  - 编辑态增加白色裁剪框：拖框移动、拖八个白手柄缩放，框外压暗，反馈保存后的窗口尺寸
  - 舞台裁剪存成相对视频帧的比例，所有片段共用；没拖动白框就不写裁剪，继续按片段自动量
  - 修保存后窗口跑到左上角：角色落点改成主进程记的锚点，不再用 setBounds 之后可能滞后的 getBounds 反推
  - 设置项尺寸文案挪到说明里，控件区只留按钮，不再被挤成竖排

* **desktop:** 摸鱼气泡支持在宠物窗口里拖拽调整大小和位置 ([855b827](https://github.com/Otherworldy/PiCode/commit/855b827118976b22e15a851a094855a2965b99b7))
  - 窗口改成「角色 + 气泡」的并集布局，角色在屏幕上的位置不随窗口涨缩移动
  - 设置页新增「气泡大小与位置」：在桌面上调整 / 恢复默认，几何按角色脚底中心存成 {x,y,w,h}，所有宠物共用
  - 编辑态把窗口临时铺满工作区，带虚线角色/窗口范围、八个缩放手柄和保存取消条，回车保存 Esc 取消
  - 高度按整行吸附，正文区保持行高整数倍；消息提醒气泡仍按缺省摆放
  - 气泡摆放函数改成纯函数内联进播放页，主进程和页面共用一套几何

* **pi-host:** 子智能体能取消，状态面板边跑边显示用量 ([e1c9039](https://github.com/Otherworldy/PiCode/commit/e1c9039b83ff259417165e28bab1c586fa7112f8))

* **ui:** 工具链和压缩摘要限高滚动 ([22c512e](https://github.com/Otherworldy/PiCode/commit/22c512e10b289b03b804bbc5413acaa237b23b20))
  - 单张工具卡不套这层：它的输出区本来就限高，再加一层只多一条滚动条。
  - 只纵向滚。单写 overflow-y: auto 会把 overflow-x 的计算值也拉成 auto，
  - 运行中的块自动吸底，读者自己上滚后停止，滚回底部恢复。内容变高
  - 压缩摘要（compact / branchSummary）套同一容器但不吸底，静态内容没有

* **ui:** 会话分支关系图谱 ([240fc35](https://github.com/Otherworldy/PiCode/commit/240fc35047e2b70dc1e8c9618cdde32eb44947ec))
  - 连线只认用户分叉 `forkedFromTaskId`；子智能体、侧聊的 `parentSessionId`
  - 布局是纯函数：范围裁剪、隐藏已删除后重挂最近可见祖先（边转虚线）、
  - 画布支持滚轮缩放、拖拽平移与适配视图；hover 高亮祖先链与后代，长标题用
  - 切换复用 `handleSelectTask` 并带上行内 `unreadAt`，与点侧栏任务行同一条链路
  - `IZCodeTaskService` 新增 `listDeletedTasks`：会话本体删除后 sessions-index
  - tasks-index 补落库：`listTaskMetas` 支持 `deleted` 过滤，与 `includeDeleted`
  - 新增 docs/specs/session-branch-graph.md，写明范围、所有者与失败语义

* **ui:** 子代理派发工具用专属卡片，不再把 wire 名当工具名 ([1a9ce20](https://github.com/Otherworldy/PiCode/commit/1a9ce2002767bbc4666d202012eee6d11b30c58f))
  - 新增 subagentToolNames（照 workflowToolNames 的口径归一大小写与分隔符，
  - fallback 卡片支持 primaryTextOverride，允许卡片自己接管摘要行主文本
  - en-US 补 chat.toolCall.kind.subagent（zh-CN 已有）

* **ui:** 子智能体卡片显示派发的角色名 ([9a70d1e](https://github.com/Otherworldy/PiCode/commit/9a70d1e8fcfe400beaaf6f0ad9b57969b2235d18))
  - subagentToolNames 新增 readSubagentDispatchRole（对象与 JSON 文本都读）
  - agent.tsx 导出 AgentNameText，派发卡复用同一套样式，不另写一份
  - 补 vitest 渲染用例：有角色名 / 无角色名 / 其它未知工具仍走原兜底卡
  - SPEC 同步摘要行与所有者


### 问题修复

* **chat:** 待办与自动化视图盖在聊天区上，不再卸载会话 ([afb2e36](https://github.com/Otherworldy/PiCode/commit/afb2e36e7eef7d6064206cc3182ac88e5b19b71f))

* **chat:** 工时计时跟着当前工作块，第一块不再一直走秒 ([d7d2637](https://github.com/Otherworldy/PiCode/commit/d7d2637b63b67c53735f2c6de43d21bf6ac74bf6))
  - WorkChunkStatus 合并原 AssistantHistoryStatus / ProcessHistoryStatus，
  - resolveWorkChunkStatusFacts 统一口径：运行态只归当前块，中断的「已停止」
  - lastFoldIndex 抽出，activeWorkingFoldIndex 复用
  - 补渲染级用例：顶部块换 nowMs 后文本不变、结束后不再出现「工作中」、

* **desktop:** 气泡抬到角色头顶上方，滚动按整行走 ([a86454e](https://github.com/Otherworldy/PiCode/commit/a86454ebc9cb36c06e578fc241e3d87bbc8bc1b5))
  - 气泡条从 64px 加到 88px：76px 气泡（4 行正文）+ 6px 间隙 + 6px 上边距，不再压住角色也不被窗口顶边裁掉
  - 气泡正文区高度改成行高整数倍，滚动一格正好一行且总是停在行边界，不会露半行
  - 触控板小步幅攒够大半行才走一格；到底或到顶再滚才翻页
  - 播放页脚本按舞台/气泡拆成两个模块，给内联函数显式传入间隙与上边距

* **pi-host:** 分叉来源被丢弃，重启后会话关系全失 ([b00cb18](https://github.com/Otherworldy/PiCode/commit/b00cb182ed5a41488f4d8822cc10e4ecfb489d3e))
  - readPiJsonl 解析 header 的 parentSession
  - 新增 sessionIdFromParentReference：路径 `<时间戳>_<sessionId>.jsonl`
  - PiStoredSummary / PiStoredSession 带上 parentSessionId，冷打开从磁盘恢复，
  - listPiStoredSummaries 把 parentSessionId 送进 sessions-index 摘要
  - 补 list / find / 冷打开三条链路的测试

* **pi-host:** 分支会话的首条消息也能被自动总结成标题 ([6db2db6](https://github.com/Otherworldy/PiCode/commit/6db2db6f86a500bd8d97ab33a29df82b34244609))
  - titleSummarySeed 支持 skipRealUsers；新增 countRealUserMessages 记分叉基线
  - 「从此处继续」在 resumeAt 裁完历史后重算基线，否则跳过条数按旧叶子算
  - session-registry 让占位分支绕过 custom 标题保护，并把标题模型调用与开关
  - fake-session 补 setSessionName，SPEC 同步占位与手动重命名的关系

* **settings:** 插件列表标出资源被配置排除的包 ([10be3da](https://github.com/Otherworldy/PiCode/commit/10be3da1cb12be18bcff1d8b410e51ed744f68a0))

* **ui:** 放慢「工作中」扫光到 3 秒 ([62ef097](https://github.com/Otherworldy/PiCode/commit/62ef097f2e6d38660939c68dd4656693d4b147ae))

* **ui:** 滚动条默认隐藏，Esc 关闭菜单不再连带取消编辑 ([22d6bcf](https://github.com/Otherworldy/PiCode/commit/22d6bcfdfa705185820d10622500eb33d3e8434c))


### 文档

* **i18n:** 补充会话统计、工作块活动、子智能体用量的文案与 spec ([d8e4970](https://github.com/Otherworldy/PiCode/commit/d8e497032aeeb11b7a2d3a40f9c937076ad74e67))


### 重构

* **chat:** 会话投影按最近使用保活，不再按秒数退订 ([b25c114](https://github.com/Otherworldy/PiCode/commit/b25c1148755cc38839eea64289f6e88a0bd77ce6))

## [3.17.0](https://github.com/Otherworldy/PiCode/compare/v3.16.0...v3.17.0) (2026-10-20)

### 新功能

* **desktop:** 新增桌面宠物模块及卡片化管理设置页 ([a9d32a2](https://github.com/Otherworldy/PiCode/commit/a9d32a2f4e48999bb2554e6cd5345d36521b64e8))
  - 支持加载 dsh-pet 兼容格式角色包，提供透明小窗交互、右键动作点播与任务状态提醒
  - 联动全部窗口的会话活跃状态呈现宠物心情（等待、思考、忙碌），支持气泡摸鱼阅读与全局热键
  - 重构桌面宠物设置页：提供待机动作素材预览卡片、本地宠物导入、下载弹窗与差异化安全删除


### 问题修复

* 扩展命令不再当成用户消息，标题总结不抢会话 ([bcaf225](https://github.com/Otherworldy/PiCode/commit/bcaf2257150ec054aac9f14742321c58bd161508))

* 问卷留在对话里，不再进扩展命令弹窗 ([031b7f4](https://github.com/Otherworldy/PiCode/commit/031b7f4163e0f312ebcc018c0685280a9b492fe1))

* **pi-host:** 终端侧栏按行拼回换行，多行输出不再黏成一行 ([7aea3f2](https://github.com/Otherworldy/PiCode/commit/7aea3f23a441a89348504ca3ba0024d1e84e066b))


### 杂项

* untrack local design mockups and ignore designs/ ([96a7f71](https://github.com/Otherworldy/PiCode/commit/96a7f719ca1c74ae57a4380206fa7f714b111e95))

## [3.16.0](https://github.com/Otherworldy/PiCode/compare/v3.15.2...v3.16.0) (2026-10-16)

### 新功能

* 给终端加上内容搜索和纵向滚动条 ([10a02c2](https://github.com/Otherworldy/PiCode/commit/10a02c2e45f799daa1bbcdc17e8b55568f49633f))

* **ui:** standardize settings controls and redesign model provider setup dialog ([f980e0b](https://github.com/Otherworldy/PiCode/commit/f980e0b97d12a871ed25282a2c03db016b96b317))
  - Redesign ProviderSetupDialog into a single-scroll view with inline connection test and key visibility toggle
  - Refactor ModelDraftCard with model filtering, compact toolbar, visual hierarchy for model ID, and thinking levels
  - Standardize settings buttons, inputs, and dialog footers to size lg (h-8)
  - Unify segmented tabs across model settings, prompt settings, and workspace dialogs into rounded-full pill style
  - Fix active tab styling for Radix data-state=active attribute
  - Expand prompt textarea height to h-[30rem] on prompt settings page
  - Update DESIGN.md and archive prototype in designs/model-provider-dialog.html


### 问题修复

* 打开会话时按文件名定位 jsonl，避免扫完全部历史 ([6fcd196](https://github.com/Otherworldy/PiCode/commit/6fcd196d2735e6f788a39c69d76edec556c0cfd6))

* 关掉的 Pi 包技能在资源重载后不再回到系统提示 ([dc8f28e](https://github.com/Otherworldy/PiCode/commit/dc8f28e990658b72b76a49acd2bbcbac62205fb9))

* 关掉内置审查页时关掉侧栏，而不是留下空白页 ([1552245](https://github.com/Otherworldy/PiCode/commit/15522452bc6a18a8265d8fa632a530b416ca30f9))

* 状态面板显示子智能体角色名 ([fc916c4](https://github.com/Otherworldy/PiCode/commit/fc916c487ae6d460703974fe5fc8658cac60d1b9))

* 子代理不出现在左侧会话列表 ([2f23945](https://github.com/Otherworldy/PiCode/commit/2f239457c36c3e62ba99bbaf2a753ddd65e94ff8))

* **pi-host:** 「正在运行」只认本进程活表 ([2895e16](https://github.com/Otherworldy/PiCode/commit/2895e16ef28a318e3f658a422ee0ffbbdbe65004))

* **pi-host:** 扫 jsonl 时也只把活表里的子会话标成在跑 ([171c00b](https://github.com/Otherworldy/PiCode/commit/171c00becd2138ee45f19ea9caa04704cf3c1f36))

* SSH 远程项目名显示主机地址而不是目录名 ([c63403f](https://github.com/Otherworldy/PiCode/commit/c63403f6cdbabf5d1af27c6172c9352c31a7f4af))

* UI 设计模式没写成 HTML 时续一次请求 ([94b9b38](https://github.com/Otherworldy/PiCode/commit/94b9b386b0e663134cc52f580bfaeb3a14655e79))

## [3.15.2](https://github.com/Otherworldy/PiCode/compare/v3.15.0...v3.15.2) (2026-10-14)

### 问题修复

* 固定手机远程控制端口 ([3338fc7](https://github.com/Otherworldy/PiCode/commit/3338fc704e7887649e6e59932fbdcc6b69277c58))

* 装 git 插件前先清掉半截检出目录 ([c3d78b9](https://github.com/Otherworldy/PiCode/commit/c3d78b9cd9ed52dc4cd0e3a63a6395bae4e69343))

## [3.15.0](https://github.com/Otherworldy/PiCode/compare/v3.14.14...v3.15.0) (2026-10-14)

### 新功能

* 在输入框上方显示 Plannotator 待办抽屉 ([1a393c9](https://github.com/Otherworldy/PiCode/commit/1a393c9474bfcb23e39db88a3de30aef19d7bc4a))

* 增加 UI 设计模式，审查等待时保留意见气泡和停止键 ([68d9c08](https://github.com/Otherworldy/PiCode/commit/68d9c08f1c03cc3d3fc0739053456138e0e7d338))


### 问题修复

* 把待办抽屉改成待发信息同款顶条 ([5354ae5](https://github.com/Otherworldy/PiCode/commit/5354ae53100cb27d8523a936036c67926b2d6408))

* 用户范围的 Pi 插件更新缓存改为全局一份 ([dd3eba3](https://github.com/Otherworldy/PiCode/commit/dd3eba3e5f94ca505f256d7839870866e43ecdc4))

## [3.14.14](https://github.com/Otherworldy/PiCode/compare/v3.14.13...v3.14.14) (2026-10-13)

### 新功能

* 把审查页交给内置浏览器，并纳入项目提示词与手机远控 ([3d3818e](https://github.com/Otherworldy/PiCode/commit/3d3818e743d82e1f14cd1aa054e70f9150f6fceb))

## [3.14.13](https://github.com/Otherworldy/PiCode/compare/v3.14.12...v3.14.13) (2026-10-13)

### 新功能

* 让手机挂到当前窗口并远程控制会话 ([f6ee26f](https://github.com/Otherworldy/PiCode/commit/f6ee26f2c91d54f776df600d15e02c0f14120c8a))


### 问题修复

* 把手机远程控制改成设置旁的图标 ([db14218](https://github.com/Otherworldy/PiCode/commit/db1421801ad0a6c6002383bac1d65f1d83240109))


### 重构

* 删除移动端bot相关功能 ([92be239](https://github.com/Otherworldy/PiCode/commit/92be239804fb7c100f9eb95702136ab0cfddc9fb))

## [3.14.12](https://github.com/Otherworldy/PiCode/compare/v3.14.11...v3.14.12) (2026-10-13)

### 问题修复

* 收紧会话资源并修正启动、Git 和标题回写 ([d8634b2](https://github.com/Otherworldy/PiCode/commit/d8634b20a5a86602d244e7c72045ef40dee14c56))
  - 内置 Pi SDK 升到 1.2.0，chrome-devtools 改为点名后才连接
  - 启动只预热当前工作区，不再为最近项目拉起空的 app-server
  - HTTP 204 不再把空响应体交给 Response，避免打崩 app-server
  - Git 命令串行执行，超时杀掉整棵进程树；文件监听忽略 node_modules
  - 重放会话时不把总结标题盖回首条原文
  - 插件安装失败时保留命令的错误输出

## [3.14.11](https://github.com/Otherworldy/PiCode/compare/v3.14.10...v3.14.11) (2026-10-12)

### 新功能

* highlight top-right update button and add plugin prerequisites notice ([65a6f5a](https://github.com/Otherworldy/PiCode/commit/65a6f5ac9f3224ba13d3ec195aa2f042c3816785))

## [3.14.10](https://github.com/Otherworldy/PiCode/compare/v3.14.9...v3.14.10) (2026-10-12)

### 新功能

* add the Pi plugin market and land today's session work ([336127c](https://github.com/Otherworldy/PiCode/commit/336127c24be33869f46a1ef1d1c9285dd6c49d61))

## [3.14.9](https://github.com/Otherworldy/PiCode/compare/v3.14.8...v3.14.9) (2026-10-11)

### 问题修复

* keep tools on conversation branches and restore fork controls ([fa746d9](https://github.com/Otherworldy/PiCode/commit/fa746d9fe98b33b0f788c7dc9981ae05c1a1a558))

* write GitHub release notes from the commits since the last tag ([e95dedf](https://github.com/Otherworldy/PiCode/commit/e95dedf933e37cb74ffcebc573cfd1b961ea936f))
