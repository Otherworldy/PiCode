# UI 设计模式

## Context

设计界面时，先看一份 HTML 稿，并在内置浏览器里圈选、批注，而不是先改产品代码。例如：「先设计一般 HTML 格式的项目提示词弹窗，保留 SYSTEM.md、APPEND_SYSTEM.md、prompts/*.md，简洁明了一点。」

Plannotator 的 `annotate` 已经能把 `.html` 按真实页面打开，批注会回到当前会话。审查页已由宿主拦到右侧内置浏览器。不改 Plannotator 源码。

进入方式用显式模式。稿件只放在工作区 `designs/`。模式开着时，Agent 只能改这里的 HTML。

## Approach

在输入框的模式菜单里加一个勾选，位置和交互对齐现有的计划模式开关：`V4ComposerModeControls` 里的勾选项，开启后再出现一枚可关闭的标记。不注册斜杠命令，也不把任何命令当成用户消息发进会话。

已有会话时，点勾选立刻发一条会话控制，走 `switchCollaborationMode` 那种路：只改宿主状态，不开新回合，不出现在时间线里。新建任务先记在草稿上，第一条消息创建会话时带上，同样不插入命令文本。宿主的 inline extension 接住这个开关，用 `setStatus("ui-design", …)` 让勾选和标记跟着会话状态走。关掉勾选或点标记上的关闭，状态清掉。新建会话默认关闭。说「可以落地」不会自动关闭，也不会开始改产品代码。

计划模式和 UI 设计模式互斥。打开这一边时，先关掉另一边。两边的写入限制不能同时生效。

模式开着时，`tool_call` 只放行 `designs/` 下的 `.html` / `.htm` 写入。`write` 和 `edit` 的路径必须落在当前工作区的 `designs/` 里，扩展名只能是这两种。`bash` 整段拒绝，避免用命令改别的文件。读文件、搜索可以照常用，这样设计时仍能看 SYSTEM.md 和现有界面。`plannotator` 工具放行。其它写入拒绝。

设计请求到来时，Agent 在 `designs/` 写一份自包含 HTML（样式和脚本都在这个文件里），对这个文件调用 `plannotator` 的 `annotate`，然后结束本轮。只写进系统提示不够：模型仍可以用文字方案结束，标注页不会开。用户消息后面再附一条不进时间线的说明；若仍无工具调用地说完且没写成 HTML，宿主续一次模型请求。一次用户消息只续一次。审查页走现有的 `embeddedBrowser.open`。批注回来后只改同一份 HTML，再打开一次。关掉审查页不是通过。不要把 HTML 转成 Markdown，也不要审一个正在跑的 dev server。

## Files to modify

- `packages/ui/src/v4/composer/V4ComposerModeControls.tsx` — 模式菜单加上 UI 设计勾选，开启后加上与计划标记同样的关闭按钮。
- `packages/ui/src/v4/SessionPane.tsx` 与 `packages/ui/src/v4/composer/useDraftConfigControl.ts` — 勾选改草稿；已有会话则发会话控制，不发聊天文本。
- `packages/shared/src/zcode-protocol-v4/command.ts` — 新增开关命令，只带是否开启。
- `apps/zcode-cli/packages/pi-host/src/ui-design-mode.ts` — 新建。接住开关、状态、路径判断、工具拦截、每轮约束。
- `apps/zcode-cli/packages/pi-host/src/ui-design-mode.test.ts` — 路径与拦截。
- `apps/zcode-cli/packages/pi-host/src/session-factory.ts` — 把扩展放进 `extensionFactories`，挨着现有的权限扩展。
- 协议命令的宿主处理，跟 `switchCollaborationMode` 同一条分发—— 把开关交给上面的扩展。
- `apps/zcode-cli/packages/pi-host/SPEC.md` — 补上勾选开关、写入边界，以及审查页仍走现有拦截。
- 中英文案：勾选名称和关闭提示。

不改 `@plannotator/pi-extension`。不改 `plannotator-browser-redirect.ts` 和右侧浏览器打开路径。

## Reuse

- `session-factory.ts` 里的 `createPermissionExtension`：同样是 `tool_call` 前拦截，不替换工具实现。UI 设计模式用自己的扩展，不把规则塞进权限模式。
- `V4ComposerModeControls` 的计划勾选和 `v4-composer-plan-marker`：UI 设计用同一种勾选加标记，不新做一种控件。
- `SessionPane` 的 `handleSwitchMode`：计划勾选会发聊天命令；这里改走会话控制，避免命令文本进时间线。
- `packages/ui/src/v4/slashCommands.ts` 的 `plannotatorPlanActive`：勾选是否勾上，看 `extensionStatuses` 里的 `ui-design`。
- `plannotator` 工具的 `annotate`，以及 `SPEC.md` 里已经写明的审查页拦截。HTML 默认按真实页面渲染。
- 插件里的计划写入判断只作参照（工作区内、禁止 `..`）。判断写在宿主自己的文件里，不引用插件内部模块。

## Steps

- [x] 实现路径判断：仅 `<cwd>/designs/**/*.html` 与 `.htm`。拒绝跑出工作区、拒绝其它扩展名。
- [x] 实现会话控制开关、`ui-design` 状态，以及模式开启时的工具拦截。不注册斜杠命令。
- [x] 在 `session-factory.ts` 注册扩展，并接上协议命令。
- [x] 模式菜单加上勾选和关闭标记。已有会话立刻切换；新建任务只改草稿，创建会话时带上。与计划模式互斥。
- [x] 扩展在模式开启时把工作流写进会话约束，不写进用户消息：写 `designs/` 里的一份自包含 HTML，调用 `annotate`，结束本轮，批注后只改该文件。
- [x] 更新 `SPEC.md`。

## Verification

- 模式菜单里能看到 UI 设计勾选。点开后出现关闭标记，时间线里不多出一条命令消息。斜杠目录里没有这条命令。
- 未勾选时，普通写文件不受影响。
- 勾选打开后，写 `designs/prompt-dialog.html` 可以；写 `src/` 或 `designs/notes.md` 被拒绝；`bash` 被拒绝；读 SYSTEM.md 可以。
- 点掉勾选或标记上的关闭后，写入恢复。打开 UI 设计时，计划模式会关掉；反过来也一样。
- 模式开着时提出文首那句设计需求。应出现 `designs/` 下的一份 HTML，右侧内置浏览器打开审查页，看到的是弹窗而不是源码。
- 提交一条批注。同一会话收到后只改该 HTML，并再次打开审查。
- 关掉审查页。不当成通过，也不改产品代码。
- 网页或手机打开同一审查地址时走系统浏览器。设置了 `PLANNOTATOR_BROWSER` 时仍走该浏览器。
