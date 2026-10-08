# 任务内查找

## 行为

Ctrl/Cmd+F 打开当前任务的消息查找。查询只写在查找框里，命中计数由当前会话时间线回传。

- 非输入法组合时，Enter、Shift+Enter、上/下方向键在已有命中时切换结果。
- 中文等 IME 组合期间，这些键留给输入法选词和确认。不得 preventDefault。
- 组合结束后紧随的那一次确认键同样留给输入法。Electron 上 `isComposing` 会在这次 keydown 之前变成 false；若把它当成“下一个结果”，候选确认会被吃掉，查询停在占位符，计数一直是 0/0。

## 所有者

查找框的 query 只由 `TaskFindDialog` 持有。时间线只读查询并回报 `matchCount`，不另存一份已提交查询。

## 验收

- 普通 Enter / 方向键仍切换命中。
- `isComposing`、`keyCode === 229`、`Process`、本地 composition 标记时不导航。
- `compositionend` 后紧随的确认键不导航。
