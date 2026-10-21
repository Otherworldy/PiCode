# 回退选择浮层

## 产品规则

- 用户消息行 →「回退到此处」（Undo 图标）：在图标旁弹出菜单，选项为「不总结 / 总结 / 自定义提示词」。不再使用带遮罩的对话框。
- 编辑用户消息后点发送、或点「重置会话和文件」：弹出同一组菜单项，选定后消息才真正提交。
- 「自定义提示词」仍是独立对话框：菜单只选动作，输入不挤进菜单。
- 菜单浮层语言与「分叉」按钮一致：`bg-menu`、紧凑行、无标题栏、点外部即关闭。

## 状态所有者

`packages/ui/src/v4/ConversationRowView.tsx` 的 `UserInputRowView` 独占以下 UI 状态，不引入协议字段或服务端状态：

| 状态                                    | 含义                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `rewindOpen`                            | 回退菜单是否展开                                                                      |
| `pendingSend`                           | 编辑提交待选定；`workspaceMode` 区分“发送”与“重置会话和文件”两个锚点                  |
| `summaryCustom` / `summaryInstructions` | 发送侧自定义总结输入                                                                  |
| `rewindCustom` / `rewindInstructions`   | 回退侧自定义总结输入                                                                  |
| `pendingCustomRef`                      | 一次性标记：本次 `onOpenChange(false)` 是“转发到自定义对话框”，不能清空 `pendingSend` |

`pendingSend` 必须在所有卸载路径上清空：`onEdit` 被收回、取消编辑、进入编辑、冲突对话框转“仅会话”。菜单随编辑子树卸载时 Radix 不会补发 `onOpenChange(false)`，残留值会让下次进入编辑直接弹菜单并提交旧文本。

## 接口

- `ResumeHereChoiceItems({ onPick, onCustom, disabled })`：`packages/ui/src/v4/ResumeHereMenu.tsx` 导出，分叉、回退、编辑重发三处共用同一动作列表（DESIGN：同一动作集复用同一动作列表）。
- `SummaryChoiceMenu({ open, onOpenChange, onPick, onCustom, trigger, disabled, onCloseAutoFocus })`：回退与编辑重发共用的菜单外壳，`trigger` 由调用方给出（可包提示层）。
- `SummaryInstructionsDialog({ open, onOpenChange, value, onChange, onConfirm, disabled })`：自定义总结要求对话框。

## 时序与关闭语义

1. 菜单 `open` 由 `rewindOpen` / `pendingSend.workspaceMode` 派生；Radix 的打开请求（指针按下、Enter/Space/↓）就是建立待选状态的时机，`onOpenChange(true)` 里读取编辑器序列化文本写入 `pendingSend`。键盘展开由 Radix trigger 处理（keydown 从内部按钮冒泡到 trigger span，并 `preventDefault` 取消合成 click）；按钮自身的 `onClick` 只补辅助技术合成的 click（`event.detail === 0`），不参与指针和键盘主路径。
2. 点「自定义提示词」：`onSelect` 先把 `pendingCustomRef` 置 true，Radix 随后关闭菜单，`onOpenChange(false)` 消费标记、保留 `pendingSend`；若反过来清空，确认对话框时就找不到待提交内容。
3. 选择任一总结方式：先清 `pendingSend` / 收起菜单，再进入提交态；提交期间菜单已卸载，`disabled` 仅作防御性保留。
4. Esc、点外部关闭菜单：等同取消本次选择，清空 `pendingSend`。编辑态两个菜单在 `ChatPromptEditor` 的 `<form>` 内，Esc 会沿 React 树冒泡到 form，所以 form 的浮层守卫按 `[role="dialog"],[role="menu"]` 排除（主 composer 不传 `onCancel`，不受影响）；回退菜单不在 form 内，无需该守卫。
5. 菜单展开期间按钮保持可见，不随行 hover 消失。
6. 菜单关闭后焦点回到 trigger span（`tabIndex=-1`，且带 Radix 的 `aria-expanded`）：提交态按钮已 disabled，不能回填到按钮；接力给自定义对话框时连 span 也不抢。按钮另带 `aria-haspopup="menu"` + `aria-expanded`，读屏不必依赖 span。

## 验收场景

- 点回退图标：菜单贴着图标出现，无遮罩；点「不总结」直接回退。
- 点「自定义提示词」：菜单收起、对话框打开；确认后按自定义要求总结回退。
- 编辑消息点发送：菜单贴着发送按钮出现；选任一项后消息才发出。
- 编辑消息点「重置会话和文件」：同一组菜单贴着该按钮出现。
- 键盘：按钮获焦后按 Enter / Space / ↓ 能展开菜单，Esc 只关菜单、不退出编辑。
- 菜单打开期间编辑入口被收回（`onEdit` 变 undefined）后再进入编辑：不残留菜单、不提交旧文本。
