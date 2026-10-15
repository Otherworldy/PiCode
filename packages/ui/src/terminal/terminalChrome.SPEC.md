# 终端查找与纵向滚动条

## 行为

- 底部终端和 side pane 终端共用 `TerminalSession`。内容查找只搜当前 xterm buffer（含 scrollback），不搜任务消息。
- 窗口级「任务内查找」快捷键（默认 Cmd/Ctrl+F，跟随用户改键）在焦点位于 `[data-terminal-session]` 内时，打开该终端的查找条，不打开任务查找，也不把按键交给 PTY。
- 查找条支持输入、上一个、下一个、区分大小写和关闭。空查询清除高亮。无匹配时显示无匹配。Esc 关闭并交回终端焦点。
- 终端 viewport 显示纵向滚动条，样式与全局滚动条一致。横向滚动条保持隐藏。

## 所有者

- 查找引擎是挂在 xterm 实例上的 `SearchAddon`。side pane 的 addon 随 registry entry 常驻；底部终端的 addon 随该次 effect 里的 xterm 一起销毁。
- 查找条的开关、查询词和大小写是 `TerminalSession` 上的 UI 状态，不进 PTY，也不写入 registry。
- 滚动条没有单独状态。`FitAddon` 使用 xterm 测得的 `scrollBarWidth` 扣掉占位，避免盖住最后一列。

## 不变量

- 焦点不在终端会话内时，原「任务内查找」行为不变。
- 查找不向 PTY 写入，关闭查找不改变 scrollback。
- 匹配高亮使用 xterm decoration，因此 xterm 必须打开 `allowProposedApi`。查找抛错只记日志并显示无匹配，不能把终端面板打进错误边界。
- side pane 卸载只解除结果订阅，不 dispose `SearchAddon`。
