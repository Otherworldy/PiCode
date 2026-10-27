# Changelog

## [3.19.1](https://github.com/Otherworldy/PiCode/compare/v3.19.0...v3.19.1) (2026-10-27)

### Features

* **ssh:** 远程连接支持 Windows 远端与空密码认证 ([94a7940](https://github.com/Otherworldy/PiCode/commit/94a7940b73ef2c01be6e143828492a41ee454bfc))
  * 连接阶段真实探测认证与远端 shell 家族（PowerShell 优先）：认证失败在连接
  * 空密码作为合法密码认证：全链路用 typeof 判断，空口令同样落 0600 凭据文件，
  * Windows 远端命令走 powershell -EncodedCommand；文件服务与 agent 工具桥按平台
  * 目录浏览器父目录推导不再写死 /，C:\ 也是根
  * 修复 identity 解析拒绝盘符路径导致 createSession 直接失败，以及 MCP 配置迁移

* **ui-design:** 审查页改由模型调用 plannotator 打开 ([d304aa4](https://github.com/Otherworldy/PiCode/commit/d304aa4ac818b093e4f900dc7d3c347124fafd9d))
  * 系统提示段 ui_design：唯一交付 designs/ 下的自包含 HTML，写明
  * 紧邻用户消息的 turn order：同一套要求，靠 ui_design 段失效。
  * 文字收尾的 nudge：覆盖「没写 HTML」和「写了没开审查」两种情况。


### Bug Fixes

* **chat:** 滚回底部后重新跟随最新输出 ([a72eeb2](https://github.com/Otherworldy/PiCode/commit/a72eeb23140d288652df77159af1874e073e37ca))
  * 工具卡收起时 scrollHeight 变小，scrollTop 被 clamp 变小，原来会被
  * 滚轮上滚时位置还没变，几何判定会把刚设好的「离开底部」读回「在底部」。

* **desktop:** 摸鱼正文的编码探测不再把 UTF-8 误判成国标 ([f66f873](https://github.com/Otherworldy/PiCode/commit/f66f8735ac4620fb7c7f14638e4ae7e70310c820))

## [3.19.0](https://github.com/Otherworldy/PiCode/compare/v3.18.1...v3.19.0) (2026-10-25)

### Features

* **chat:** 回退到此处可撤销消息之后的文件改动 ([aa7b242](https://github.com/Otherworldy/PiCode/commit/aa7b2422c3cf1daba549e579d52e903473150729))
  * 回退前预检锚点及之后所有 turn 的文件改动，弹确认框选「只回退对话」或「撤销文件并回退」
  * 文件撤销与对话裁切合并进同一条 editUserQuery，避免两条 CAS 命令踩 revision
  * core 按 active chain、Pi host 按投影窗口各实现 suffix 展开；覆盖已有文件的 Write 判为不可撤销
  * 确认框沿用 Dialog 默认规格，宽度与项目确认弹窗一致

* **sidebar:** 项目支持重命名，改名弹窗与其它对话框对齐 ([64b886e](https://github.com/Otherworldy/PiCode/commit/64b886e7ed4d839f5b68be0a3aa5459f53901e31))
  * 侧栏「更多」菜单新增「重命名项目」，本地和远程项目都可用，只改显示名，不动路径、身份和连接目标
  * 显示名优先级 自定义名 → SSH 主机名 → 目录名，侧栏、拖拽预览、顶栏、命令面板、任务归属、空态项目菜单、文件树、手机工作区列表、插件作用域、自动化候选统一走同一解析
  * 随 lastWorkspaceSession 持久化：恢复、重连、首帧补齐都不会丢自定义名，清空改名也不会在重启后复活旧名
  * 侧栏菜单打开改名弹窗时显式收起菜单，避免下拉和弹框同时停留
  * 改名弹窗统一到 max-w-3xl、标题 18px、输入框与按钮同高 40
  * 补 testid 与 vitest：显示名解析/归一化/持久化映射、store 改名与恢复优先级

* **subagents:** 子智能体内置工具清单可配置 ([886cf32](https://github.com/Otherworldy/PiCode/commit/886cf32b7b335dc932a4316cf7ae97dffababd6f))
  * Pi host 暴露运行时可用工具清单，bootstrap 经 agent-tool-catalog 转成可选项目
  * 子智能体 profile 支持 builtInToolOverrides，设置页按角色勾选或恢复默认
  * pi SDK 升级到 1.4.0

* **ui:** 工作块运行中的动作标题按工具分类并轮换文案 ([b17715f](https://github.com/Otherworldy/PiCode/commit/b17715f686b28458b1a34f118b1cf51fe932ca3d))


### Bug Fixes

* **agent:** 工作区事件帧与交互回执按工作区回收 ([a4c00a4](https://github.com/Otherworldy/PiCode/commit/a4c00a41592c34338b8733516743cac943106337))
  * getOrCreateWorkspaceEmitter / fireWorkspaceFrame 的 emitter 表原来只增不减：
  * userInput.resolved 回执要同时查两张表（resolved 与 pending），否则解析后

* **browser:** 下载监听与录制 Session 不再泄漏 ([fda8639](https://github.com/Otherworldy/PiCode/commit/fda86399269a3b956f43c53279883e089ebcd981))
  * setupDownloadTracking 的 will-download 监听挂在 session 上，guest 销毁后
  * 录制 session 原来每次录制都用 fromPartition(zcode-browser-video-recorder-${uuid})：
  * Playwright executor 补上页面上下文需要的 DOM 类型声明（main 工程不带 dom

* **cli:** stdio 按行切分，drain 以 bufferedAmount 为准并有上限 ([6c7ba49](https://github.com/Otherworldy/PiCode/commit/6c7ba491f7f0d5a0c99d3d3e214fa17a28f88c13))
  * 原来按 chunk 直接 split("\n")：一个 UTF-8 多字节字符被切在两个 chunk 之间
  * drain() 改成轮询 bufferedAmount（ws 没有 bufferedamountlow 事件），16ms
  * 手机远控链路同步改成同样的轮询语义，不再伪造「已经排空」的信号。

* **config:** cli/config.json 收敛为单一带锁写者 ([dc84560](https://github.com/Otherworldy/PiCode/commit/dc845607588caf5c7e6f2c8b9965301698a7d60c))
  * 新增 userCliConfigFile.ts：updateJsonConfigFile 用文件锁串行化读改写。
  * 写入路径的读取必须严格：只有 ENOENT 当空文件，其它错误直接抛，避免把损坏的
  * 路径解析改为函数而不是模块级常量：ensureAppDataDir 的 .zcode→.PiCode 迁移
  * pluginSyncService 的 addPluginDirToUserConfig 原来用本地 writeJsonFileAtomic

* **desktop:** 宠物包下载的写盘错误不再打死 main 进程 ([d6e51e6](https://github.com/Otherworldy/PiCode/commit/d6e51e6eac03787466ec7d16f79bdfe76a738bbe))

* **desktop:** 手机远控配对 cookie 持久 30 天，失效时给可读提示 ([560305a](https://github.com/Otherworldy/PiCode/commit/560305a30cc858a922b702a443fa4e9ed1a8ec87))
  * 配对 cookie 加 Max-Age=30 天，回到手机不用再回桌面重新扫码。局域网是明文
  * 口令对不上时，浏览器导航请求返回一页可读提示（配对已失效，回桌面重新扫码）；
  * 顺手修掉畸形 cookie 让 decodeURIComponent 抛 URIError 的问题。异常冒到 Main

* **desktop:** 远程连接超时、采样 latch 与沙箱生命周期 ([4401e10](https://github.com/Otherworldy/PiCode/commit/4401e109fbb8ee18c0d92209a4c20e71385c3b38))
  * ConnectRemote 原来没有任何定时器：对端不响应时 PendingConnect 永久挂着。
  * resourceManagerHostSampling 的超时回调只 resolve 不摘 requestIdByHost，
  * 沙箱按文档的五个生命周期阶段收口：clearing 用 try/finally，guestPolicy

* **memory:** 给缓存与额度加界，限制单次读取量 ([e3fd2bd](https://github.com/Otherworldy/PiCode/commit/e3fd2bd14317d5cc5363a94b94f91b66ae0649ac))
  * shiki tokensCache 加 LRU（200 条 / 8MiB 总量 / 单条 200k）。
  * plugin-ui 实例、gen-ui stateStorage、taskQueryCache、sessionWorktree 缓存、
  * pi-host projector 终态后不再保留完整 inputText（row.inputText 已有）；
  * MCP UI 调用加 per-instance 4 并发 / per-session 500 次 / 120s 超时；
  * taskRealtimeBus 分片改 netstring 长度前缀（原来 O(K²) stringify）；
  * proxyFetch 的 agent 表加界，超额时 close 而不是只从表里删（否则连接池继续
  * 日志写入改 WriteStream，hostLogRelay 保留 2000 条。

* **memory:** 遥测队列与 gen-ui 派生缓存不再无界增长 ([d7b18bd](https://github.com/Otherworldy/PiCode/commit/d7b18bd73bfcd691cc291f9f467d5288c7ea0e97))

* **pi-host:** 扩展命令的作废状态不再漏到之后的工具提问 ([bf68ad5](https://github.com/Otherworldy/PiCode/commit/bf68ad581f15e616eb0f0e34e1e1cc3815400647))
  * 只有扩展命令跑着（depth > 0）时，停止才作废这次命令剩下的提问。
  * 嵌套命令按帧保存外层 dismissed，内层结束不把外层的决定带脏。
  * handleUi 只在命令内因 dismissed 静默取消；命令外（工具发起的提问）照常弹。
  * depth 用 Math.max(0, ...) 收口，避免重复结束把计数压成负数。
  * 补三个场景：普通轮次停止不吞后续提问、命令结束后不再吞、命令内停止只取消

* **remote:** SSH 密码认证可用，目录浏览器默认打开远端 home ([66c61df](https://github.com/Otherworldy/PiCode/commit/66c61dfc16c20103a628207f46563c697331bdb6))
  * 密码不再只在 UI 里：Host 写入 0600 私有凭据文件，spec / agent spawn env / 子进程只带路径，askpass 从文件读口令
  * 有密码时改 BatchMode=no 并走 password,keyboard-interactive；askpass 形态按 ssh -V 判定 .cmd 或 sh 脚本
  * 主机密钥统一 TOFU（StrictHostKeyChecking=accept-new），指纹变化仍然拒绝
  * 目录浏览器起始目录探测远端 $HOME，失败回退 /www/wwwroot、/var/www、/opt、/srv、/home，最后回 /
  * 修 child.stdin EPIPE 未捕获、signal 已 abort 时子进程不被杀
  * bind 用 Host 内部未脱敏 target 重建 spec，避免脱敏快照覆盖 agent 侧凭据

* **rpc:** 限制单帧大小，隔离单次调用错误，按连接回收资源 ([dbcc637](https://github.com/Otherworldy/PiCode/commit/dbcc637832453bcdaacfe315e7631ed0093daaad))
  * 帧上限 MAX_FRAME_BYTES = 64MiB：超出直接断开，避免一条畸形长度头就把
  * 单次 RPC 抛错不再影响同连接上的其它调用：错误只回给发起方，连接保持可用。
  * host/index.ts 按连接包装服务：记录本连接创建的 terminal id，连接 dispose 时
  * docker-backend 的 dispose 只 kill 已证明归属的子进程，绝不 terminate 容器。

* **startup:** 存储启动等待加进度看门狗，不再永久挂起 ([d105ad1](https://github.com/Otherworldy/PiCode/commit/d105ad11f8010e920cb0186911a1b5525956f332))
  * 新增 createProgressWatchdog(firstFrameTimeoutMs, stallTimeoutMs)：首帧 30s、
  * zcodeStorageStartupGate 每帧续期；waiting_for_lock 暂停计时（锁等待有独立的
  * gate 失败后 zcodeProtocolClient 主动 rejectAll：本地 fail 不走 handleMessage，
  * 存储 worker 的 failed 终态帧也要喂看门狗（上一帧若是 waiting_for_lock，
  * worker.terminate() 抢占不了 node:sqlite 的同步原生调用，超时后直接 reject

* **todo:** 兼容旧库列名，后台对齐失败不再杀死 Host ([8153589](https://github.com/Otherworldy/PiCode/commit/81535899c6cca00b36c77eb722f3aa6760eb0cc4))
  * 新增 todoSchemaCompat.ts：补列并回填旧值（session_id ← last_session_id、
  * alignTodos 加 catch + warn，一次后台对齐失败只丢一条日志。

* **ui:** 文件搜索 Worker 崩溃后真正降级到主线程 ([0ecb93b](https://github.com/Otherworldy/PiCode/commit/0ecb93bf31a48b63c30b881204f40a017cfbf0b6))


### Chores

* 忽略 pi-host 编译产物，清理无用导入与类型配置 ([2af3878](https://github.com/Otherworldy/PiCode/commit/2af3878206539df449ce3b70f562c29636d7f521))
  * build-desktop-agent-cli 会在 pi-host/src 下生成 .js/.d.ts/.map，这些文件
  * 删除 desktopCommandHandlers / desktopHostProcess 里已不用的 import。
  * 补齐 main 进程 typecheck 配置与 browser-perf-probe 的类型声明。
  * AboutSettingsSection 加 max-lines 豁免（各分区共享同一份版本快照）。


### Refactorings

* **ui:** 移除 onboarding 引导、办公模式与主动推荐 ([190d656](https://github.com/Otherworldy/PiCode/commit/190d656427bcb30de187b3540c3db683e7c906fc))
  * 删除引导流程、设置同步、办公模式与草稿主动推荐入口及相关 i18n
  * 清理 isOfficeMode / interfaceMode / toggleInterfaceMode 等跨包引用
  * 工作区插件排序去掉办公模式维度
  * 修正 ConversationTimeline 与下载进度文案的遗留类型错误

## [3.18.1](https://github.com/Otherworldy/PiCode/compare/v3.18.0...v3.18.1) (2026-10-21)

### Features

* **desktop:** 按住摸鱼自动翻页，宠物窗口按角色形状裁剪命中区 ([1e6dbe1](https://github.com/Otherworldy/PiCode/commit/1e6dbe1e25d88429766002c60e032508ea3e1e19))
  * 自动翻页：按住模式可开关，速率按每行毫秒数自由填（200–20000，缺省 1200）。
  * 窗口形状：用 setShape 把窗口裁到角色和气泡两块矩形，形状外不绘制也不收事件。
  * 修设置白名单漏字段：只改自动翻页时整条 patch 被丢弃，开关看起来打开却不生效。


### Bug Fixes

* **desktop:** 更新安装期间保留可见进度窗口 ([d1999ae](https://github.com/Otherworldy/PiCode/commit/d1999ae03e781944d1620efc2eede40be2af2df8))

## [3.18.0](https://github.com/Otherworldy/PiCode/compare/v3.17.0...v3.18.0) (2026-10-21)

### Features

* **chat:** 工作块标题按当前动作展示，结束时报用时与调用次数 ([85affbb](https://github.com/Otherworldy/PiCode/commit/85affbb81859f69a788c06aa2d2eb20bcefe3778))

* **chat:** 回退与分叉共用一套续接动作列表 ([8aa2cc2](https://github.com/Otherworldy/PiCode/commit/8aa2cc29b2829ec8cad94b3de18c71d6fff26c8d))

* **chat:** 轮尾展示本轮用量，工时只算干活时间 ([7150485](https://github.com/Otherworldy/PiCode/commit/7150485be76a2e617a1ad9e78a145abd9122236d))
  * turnHeader 新增 usage：pi-host 从 Pi 的 message_end 读 token 与
  * 缓存命中率按 cacheRead / (input + cacheRead + cacheWrite)。Pi 的
  * 吐字速度只算解码时间，扣掉首 token 等待；一次调用缺时长就整轮不给，
  * 失败、中断、deferred 回填的调用 usage 全零，整次跳过：否则一次超时
  * 轮尾操作栏改成常显，用量 pill 跟在复制/反馈/分叉之后，点击弹明细；
  * activeMs 改成净工作时间：权限审批、ask_user_question 提问、hook 审核
  * 并发等待合并成一段，后到的请求不截断先到的；resolved 丢失时由工具
  * waitedMs 只报已结束的等待，进行中的那段由 waitingSince 单独表达，
  * 「工作中」改成「工作中，用时 54 秒」，带扫光动画，用时与折叠标题同口径
  * pi-host 全量测试 222 通过；turn-usage 15 个、turn-wait-clock 9 个、
  * typecheck 与改动前基线一致（3 个既有错误，均在未改动的文件）
  * architecture:check --changed 0 违规

* **chat:** 输入框下方展示会话统计，插件状态入口下移 ([e0b299f](https://github.com/Otherworldy/PiCode/commit/e0b299f2dabfc348938b81292bd6048412b7c81b))
  * 新增 turns/steps 与 llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens，
  * 一步 = 一次产生用量的模型调用；零用量的失败/中断/冷恢复占位事件不计步
  * 时间指标只累加真实可得的时长：模型用时取 durationMs，解码段是总时长减

* **desktop:** 宠物窗口裁到角色区域，新增显示大小与裁剪开关 ([c286d22](https://github.com/Otherworldy/PiCode/commit/c286d2218b8a65594443c1abb0d0ff41d102429b))
  * 渲染端每段动画量一次角色不透明像素框，窗口和可点/可拖区域贴着角色，不再包含视频自带的透明留白
  * 量到的框缓存到 pets/box.json，重启直接按它建窗口
  * 新增 desktopPetDisplayScale（50%–150%）与 desktopPetCropCharacter（默认开启）
  * 气泡定位改为按角色顶边在舞台里的比例计算

* **desktop:** 宠物舞台支持自由裁剪，修保存后窗口跳位和设置行断行 ([67cf56e](https://github.com/Otherworldy/PiCode/commit/67cf56e819d07992058574e7ee8c2fb7dd22a70a))
  * 编辑态增加白色裁剪框：拖框移动、拖八个白手柄缩放，框外压暗，反馈保存后的窗口尺寸
  * 舞台裁剪存成相对视频帧的比例，所有片段共用；没拖动白框就不写裁剪，继续按片段自动量
  * 修保存后窗口跑到左上角：角色落点改成主进程记的锚点，不再用 setBounds 之后可能滞后的 getBounds 反推
  * 设置项尺寸文案挪到说明里，控件区只留按钮，不再被挤成竖排

* **desktop:** 摸鱼气泡支持在宠物窗口里拖拽调整大小和位置 ([855b827](https://github.com/Otherworldy/PiCode/commit/855b827118976b22e15a851a094855a2965b99b7))
  * 窗口改成「角色 + 气泡」的并集布局，角色在屏幕上的位置不随窗口涨缩移动
  * 设置页新增「气泡大小与位置」：在桌面上调整 / 恢复默认，几何按角色脚底中心存成 {x,y,w,h}，所有宠物共用
  * 编辑态把窗口临时铺满工作区，带虚线角色/窗口范围、八个缩放手柄和保存取消条，回车保存 Esc 取消
  * 高度按整行吸附，正文区保持行高整数倍；消息提醒气泡仍按缺省摆放
  * 气泡摆放函数改成纯函数内联进播放页，主进程和页面共用一套几何

* **pi-host:** 子智能体能取消，状态面板边跑边显示用量 ([e1c9039](https://github.com/Otherworldy/PiCode/commit/e1c9039b83ff259417165e28bab1c586fa7112f8))

* **ui:** 工具链和压缩摘要限高滚动 ([22c512e](https://github.com/Otherworldy/PiCode/commit/22c512e10b289b03b804bbc5413acaa237b23b20))
  * 单张工具卡不套这层：它的输出区本来就限高，再加一层只多一条滚动条。
  * 只纵向滚。单写 overflow-y: auto 会把 overflow-x 的计算值也拉成 auto，
  * 运行中的块自动吸底，读者自己上滚后停止，滚回底部恢复。内容变高
  * 压缩摘要（compact / branchSummary）套同一容器但不吸底，静态内容没有

* **ui:** 会话分支关系图谱 ([240fc35](https://github.com/Otherworldy/PiCode/commit/240fc35047e2b70dc1e8c9618cdde32eb44947ec))
  * 连线只认用户分叉 `forkedFromTaskId`；子智能体、侧聊的 `parentSessionId`
  * 布局是纯函数：范围裁剪、隐藏已删除后重挂最近可见祖先（边转虚线）、
  * 画布支持滚轮缩放、拖拽平移与适配视图；hover 高亮祖先链与后代，长标题用
  * 切换复用 `handleSelectTask` 并带上行内 `unreadAt`，与点侧栏任务行同一条链路
  * `IZCodeTaskService` 新增 `listDeletedTasks`：会话本体删除后 sessions-index
  * tasks-index 补落库：`listTaskMetas` 支持 `deleted` 过滤，与 `includeDeleted`
  * 新增 docs/specs/session-branch-graph.md，写明范围、所有者与失败语义

* **ui:** 子代理派发工具用专属卡片，不再把 wire 名当工具名 ([1a9ce20](https://github.com/Otherworldy/PiCode/commit/1a9ce2002767bbc4666d202012eee6d11b30c58f))
  * 新增 subagentToolNames（照 workflowToolNames 的口径归一大小写与分隔符，
  * fallback 卡片支持 primaryTextOverride，允许卡片自己接管摘要行主文本
  * en-US 补 chat.toolCall.kind.subagent（zh-CN 已有）

* **ui:** 子智能体卡片显示派发的角色名 ([9a70d1e](https://github.com/Otherworldy/PiCode/commit/9a70d1e8fcfe400beaaf6f0ad9b57969b2235d18))
  * subagentToolNames 新增 readSubagentDispatchRole（对象与 JSON 文本都读）
  * agent.tsx 导出 AgentNameText，派发卡复用同一套样式，不另写一份
  * 补 vitest 渲染用例：有角色名 / 无角色名 / 其它未知工具仍走原兜底卡
  * SPEC 同步摘要行与所有者


### Bug Fixes

* **chat:** 待办与自动化视图盖在聊天区上，不再卸载会话 ([afb2e36](https://github.com/Otherworldy/PiCode/commit/afb2e36e7eef7d6064206cc3182ac88e5b19b71f))

* **chat:** 工时计时跟着当前工作块，第一块不再一直走秒 ([d7d2637](https://github.com/Otherworldy/PiCode/commit/d7d2637b63b67c53735f2c6de43d21bf6ac74bf6))
  * WorkChunkStatus 合并原 AssistantHistoryStatus / ProcessHistoryStatus，
  * resolveWorkChunkStatusFacts 统一口径：运行态只归当前块，中断的「已停止」
  * lastFoldIndex 抽出，activeWorkingFoldIndex 复用
  * 补渲染级用例：顶部块换 nowMs 后文本不变、结束后不再出现「工作中」、

* **desktop:** 气泡抬到角色头顶上方，滚动按整行走 ([a86454e](https://github.com/Otherworldy/PiCode/commit/a86454ebc9cb36c06e578fc241e3d87bbc8bc1b5))
  * 气泡条从 64px 加到 88px：76px 气泡（4 行正文）+ 6px 间隙 + 6px 上边距，不再压住角色也不被窗口顶边裁掉
  * 气泡正文区高度改成行高整数倍，滚动一格正好一行且总是停在行边界，不会露半行
  * 触控板小步幅攒够大半行才走一格；到底或到顶再滚才翻页
  * 播放页脚本按舞台/气泡拆成两个模块，给内联函数显式传入间隙与上边距

* **pi-host:** 分叉来源被丢弃，重启后会话关系全失 ([b00cb18](https://github.com/Otherworldy/PiCode/commit/b00cb182ed5a41488f4d8822cc10e4ecfb489d3e))
  * readPiJsonl 解析 header 的 parentSession
  * 新增 sessionIdFromParentReference：路径 `<时间戳>_<sessionId>.jsonl`
  * PiStoredSummary / PiStoredSession 带上 parentSessionId，冷打开从磁盘恢复，
  * listPiStoredSummaries 把 parentSessionId 送进 sessions-index 摘要
  * 补 list / find / 冷打开三条链路的测试

* **pi-host:** 分支会话的首条消息也能被自动总结成标题 ([6db2db6](https://github.com/Otherworldy/PiCode/commit/6db2db6f86a500bd8d97ab33a29df82b34244609))
  * titleSummarySeed 支持 skipRealUsers；新增 countRealUserMessages 记分叉基线
  * 「从此处继续」在 resumeAt 裁完历史后重算基线，否则跳过条数按旧叶子算
  * session-registry 让占位分支绕过 custom 标题保护，并把标题模型调用与开关
  * fake-session 补 setSessionName，SPEC 同步占位与手动重命名的关系

* **settings:** 插件列表标出资源被配置排除的包 ([10be3da](https://github.com/Otherworldy/PiCode/commit/10be3da1cb12be18bcff1d8b410e51ed744f68a0))

* **ui:** 放慢「工作中」扫光到 3 秒 ([62ef097](https://github.com/Otherworldy/PiCode/commit/62ef097f2e6d38660939c68dd4656693d4b147ae))

* **ui:** 滚动条默认隐藏，Esc 关闭菜单不再连带取消编辑 ([22d6bcf](https://github.com/Otherworldy/PiCode/commit/22d6bcfdfa705185820d10622500eb33d3e8434c))


### Documentation

* **i18n:** 补充会话统计、工作块活动、子智能体用量的文案与 spec ([d8e4970](https://github.com/Otherworldy/PiCode/commit/d8e497032aeeb11b7a2d3a40f9c937076ad74e67))


### Refactorings

* **chat:** 会话投影按最近使用保活，不再按秒数退订 ([b25c114](https://github.com/Otherworldy/PiCode/commit/b25c1148755cc38839eea64289f6e88a0bd77ce6))

## [3.17.0](https://github.com/Otherworldy/PiCode/compare/v3.16.0...v3.17.0) (2026-10-20)

### Features

* **desktop:** 新增桌面宠物模块及卡片化管理设置页 ([a9d32a2](https://github.com/Otherworldy/PiCode/commit/a9d32a2f4e48999bb2554e6cd5345d36521b64e8))
  * 支持加载 dsh-pet 兼容格式角色包，提供透明小窗交互、右键动作点播与任务状态提醒
  * 联动全部窗口的会话活跃状态呈现宠物心情（等待、思考、忙碌），支持气泡摸鱼阅读与全局热键
  * 重构桌面宠物设置页：提供待机动作素材预览卡片、本地宠物导入、下载弹窗与差异化安全删除


### Bug Fixes

* 扩展命令不再当成用户消息，标题总结不抢会话 ([bcaf225](https://github.com/Otherworldy/PiCode/commit/bcaf2257150ec054aac9f14742321c58bd161508))

* 问卷留在对话里，不再进扩展命令弹窗 ([031b7f4](https://github.com/Otherworldy/PiCode/commit/031b7f4163e0f312ebcc018c0685280a9b492fe1))

* **pi-host:** 终端侧栏按行拼回换行，多行输出不再黏成一行 ([7aea3f2](https://github.com/Otherworldy/PiCode/commit/7aea3f23a441a89348504ca3ba0024d1e84e066b))


### Chores

* untrack local design mockups and ignore designs/ ([96a7f71](https://github.com/Otherworldy/PiCode/commit/96a7f719ca1c74ae57a4380206fa7f714b111e95))

## [3.16.0](https://github.com/Otherworldy/PiCode/compare/v3.15.2...v3.16.0) (2026-10-16)

### Features

* 给终端加上内容搜索和纵向滚动条 ([10a02c2](https://github.com/Otherworldy/PiCode/commit/10a02c2e45f799daa1bbcdc17e8b55568f49633f))

* **ui:** standardize settings controls and redesign model provider setup dialog ([f980e0b](https://github.com/Otherworldy/PiCode/commit/f980e0b97d12a871ed25282a2c03db016b96b317))
  * Redesign ProviderSetupDialog into a single-scroll view with inline connection test and key visibility toggle
  * Refactor ModelDraftCard with model filtering, compact toolbar, visual hierarchy for model ID, and thinking levels
  * Standardize settings buttons, inputs, and dialog footers to size lg (h-8)
  * Unify segmented tabs across model settings, prompt settings, and workspace dialogs into rounded-full pill style
  * Fix active tab styling for Radix data-state=active attribute
  * Expand prompt textarea height to h-[30rem] on prompt settings page
  * Update DESIGN.md and archive prototype in designs/model-provider-dialog.html


### Bug Fixes

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

### Bug Fixes

* 固定手机远程控制端口 ([3338fc7](https://github.com/Otherworldy/PiCode/commit/3338fc704e7887649e6e59932fbdcc6b69277c58))

* 装 git 插件前先清掉半截检出目录 ([c3d78b9](https://github.com/Otherworldy/PiCode/commit/c3d78b9cd9ed52dc4cd0e3a63a6395bae4e69343))

## [3.15.0](https://github.com/Otherworldy/PiCode/compare/v3.14.14...v3.15.0) (2026-10-14)

### Features

* 在输入框上方显示 Plannotator 待办抽屉 ([1a393c9](https://github.com/Otherworldy/PiCode/commit/1a393c9474bfcb23e39db88a3de30aef19d7bc4a))

* 增加 UI 设计模式，审查等待时保留意见气泡和停止键 ([68d9c08](https://github.com/Otherworldy/PiCode/commit/68d9c08f1c03cc3d3fc0739053456138e0e7d338))


### Bug Fixes

* 把待办抽屉改成待发信息同款顶条 ([5354ae5](https://github.com/Otherworldy/PiCode/commit/5354ae53100cb27d8523a936036c67926b2d6408))

* 用户范围的 Pi 插件更新缓存改为全局一份 ([dd3eba3](https://github.com/Otherworldy/PiCode/commit/dd3eba3e5f94ca505f256d7839870866e43ecdc4))

## [3.14.14](https://github.com/Otherworldy/PiCode/compare/v3.14.13...v3.14.14) (2026-10-13)

### Features

* 把审查页交给内置浏览器，并纳入项目提示词与手机远控 ([3d3818e](https://github.com/Otherworldy/PiCode/commit/3d3818e743d82e1f14cd1aa054e70f9150f6fceb))

## [3.14.13](https://github.com/Otherworldy/PiCode/compare/v3.14.12...v3.14.13) (2026-10-13)

### Features

* 让手机挂到当前窗口并远程控制会话 ([f6ee26f](https://github.com/Otherworldy/PiCode/commit/f6ee26f2c91d54f776df600d15e02c0f14120c8a))


### Bug Fixes

* 把手机远程控制改成设置旁的图标 ([db14218](https://github.com/Otherworldy/PiCode/commit/db1421801ad0a6c6002383bac1d65f1d83240109))


### Refactorings

* 删除移动端bot相关功能 ([92be239](https://github.com/Otherworldy/PiCode/commit/92be239804fb7c100f9eb95702136ab0cfddc9fb))

## [3.14.12](https://github.com/Otherworldy/PiCode/compare/v3.14.11...v3.14.12) (2026-10-13)

### Bug Fixes

* 收紧会话资源并修正启动、Git 和标题回写 ([d8634b2](https://github.com/Otherworldy/PiCode/commit/d8634b20a5a86602d244e7c72045ef40dee14c56))
  * 内置 Pi SDK 升到 1.2.0，chrome-devtools 改为点名后才连接
  * 启动只预热当前工作区，不再为最近项目拉起空的 app-server
  * HTTP 204 不再把空响应体交给 Response，避免打崩 app-server
  * Git 命令串行执行，超时杀掉整棵进程树；文件监听忽略 node_modules
  * 重放会话时不把总结标题盖回首条原文
  * 插件安装失败时保留命令的错误输出

## [3.14.11](https://github.com/Otherworldy/PiCode/compare/v3.14.10...v3.14.11) (2026-10-12)

### Features

* highlight top-right update button and add plugin prerequisites notice ([65a6f5a](https://github.com/Otherworldy/PiCode/commit/65a6f5ac9f3224ba13d3ec195aa2f042c3816785))

## [3.14.10](https://github.com/Otherworldy/PiCode/compare/v3.14.9...v3.14.10) (2026-10-12)

### Features

* add the Pi plugin market and land today's session work ([336127c](https://github.com/Otherworldy/PiCode/commit/336127c24be33869f46a1ef1d1c9285dd6c49d61))

## [3.14.9](https://github.com/Otherworldy/PiCode/compare/v3.14.8...v3.14.9) (2026-10-11)

### Bug Fixes

* keep tools on conversation branches and restore fork controls ([fa746d9](https://github.com/Otherworldy/PiCode/commit/fa746d9fe98b33b0f788c7dc9981ae05c1a1a558))

* write GitHub release notes from the commits since the last tag ([e95dedf](https://github.com/Otherworldy/PiCode/commit/e95dedf933e37cb74ffcebc573cfd1b961ea936f))
