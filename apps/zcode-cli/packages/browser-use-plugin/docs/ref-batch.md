# 内置浏览器 ref 批处理

## 行为

普通点击和填写走 ref，而不是每一步重建 locator：

1. `playwright.refSnapshot()` 读无障碍树，给可见的可交互节点分配 `e1`、`e2`……。同一 `backendDOMNodeId` 在后续快照里保持原句柄。同一层 iframe 的内容缩进附在后面；跨域 iframe 读不到就跳过。
2. 已知标签上，同一次 JS 可以 `tabs.get`、`refSnapshot`、`refBatch`。`refBatch` 里多次 fill 和 click 算一条命令。
3. 动作之后用 `playwright.refDiff()` 看相对上一份 ref 快照的增减，不要为了确认结果再读整棵 AI 树。可能弹出新标签时仍要同时看 controlled tabs 和 user tabs。

点击和填写都按 `backendDOMNodeId` 找到节点。DOM 重排但不导航时，旧句柄仍指向原节点。

## 所有者

句柄表只活在标签页的 isolated world（`globalThis.__zcodeRefBatch`）。`ControlledView` 每次命令都是新对象，不能当所有者。页面主世界又能被站点清掉。导航销毁 world 后句柄失效。URL 变化时批处理和 diff 失败，必须重新 `refSnapshot()`。

headless CDP adapter 不实现这些命令。

## 失败

- 没有快照、URL 变了、句柄不存在、节点已消失：`execution_error`。已执行的前缀动作不回滚。
- 一次最多 8 个动作，快照最多 200 个元素。
- 不展开 iframe 里的 iframe。

## 不改变

`domSnapshot` 和 locator 仍用于 closed shadow、ref 列表里没有的目标，以及需要完整 AI 树的判断。locator 路径仍是一轮一个会改状态的动作。
