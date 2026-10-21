# Changelog

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
