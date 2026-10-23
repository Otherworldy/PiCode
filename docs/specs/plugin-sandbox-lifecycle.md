# 插件沙箱生命周期：清除数据与权限授权的状态收尾

## 背景

`pluginSandbox/host.ts` 用一组闭包状态管理 sandbox 的生命周期：`guests`（WebContents）、
`partitions`（持久分区名）、`clearing`（"正在清除数据"闸门）。审计发现 `clearing` 是**单向
闩锁**：`clearBrowserData()` 开头置 `true`，函数结束不复位。

后果不是内存增长，是**功能永久锁死**：设置页点一次"清除数据"之后，此后所有
`registerFromHost` 都抛 `MCP App browser data is being cleared`，所有新 guest 一挂上就被
`stopGuest`，直到重启应用。现场没有任何提示，用户只会觉得"插件坏了"。

同一区域还有一处**安全语义**问题：`permissionGate.consented` 按 partition 常驻，清除数据
和 owner 销毁都不清。重装同名插件会继承上一版的摄像头/麦克风授权。

## 状态所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| `clearing` | 一次 `clearBrowserData()` 调用 | 只在该调用期间为 `true` |
| `partitions` | sandbox host | host 生命周期（持久分区不会被删） |
| `guests` | 一个 sandboxId | `destroyed` 事件；`onDispose` 必须兜底 |
| `consented` | 一个 partition 的插件身份 | 与 partition 的信任关系；**清除数据时重置** |

## 规则

1. **临时闸门标志必须在 `finally` 复位。** `clearing` 这类"操作进行中"的标志语义上等价于
   一个锁；锁不能只在成功路径释放。用 `try/finally`，不要靠调用方记得复位。
2. **清除数据的语义是"回到未授权状态"。** 它必须同时清掉 `consented`：用户点"清除浏览器
   数据"时，预期是权限确认框重新出现一次，而不是沿用旧授权。
3. **`onDispose` 不能假设 `destroyed` 事件一定到达。** `guests` 的删除依赖 WebContents 的
   `destroyed`；页面进程崩溃时该事件可能不触发。`onDispose` 在 `stopGuest` 完成后兜底
   `guests.delete(sandboxId)`（用身份比较，避免删掉重新挂载的新 guest）。
4. **`stopGuest` 失败路径不能留下 rejected promise。** 现有实现把 promise 存进 `stopping`
   WeakMap 复用；若首个调用 reject，后续调用会拿到同一个 rejected promise。失败时清表项。

## 验收场景

- 点一次"清除数据" → 打开插件 → guest 正常挂载（不加规则 1 时永久抛错）。
- 清除数据 → 重装同名插件 → 摄像头权限确认框**重新出现**（不加规则 2 时静默继承）。
- 插件页加载中崩溃 → 关闭窗口 → `guests` 无残留条目（不加规则 3 时残留 WebContents）。
- `about:blank` 导航因竞争抛错 → 再次 attach 同 sandboxId → 旧 guest 仍被正确停止。
