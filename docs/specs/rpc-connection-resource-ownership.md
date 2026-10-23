# RPC 连接级资源回收

## 背景

host 里的 `terminal` 与 `fileWatcher` 是**host 级单例**，资源（pty 进程 / `fs.watch` 句柄）只由
调用方显式释放（`terminal.dispose({id})` / `fileWatcher.unwatch({id})`）。

UI 侧在组件 unmount 时确实会释放，但 renderer 刷新、渲染进程崩溃、窗口关闭这三种情况下
unmount 不会执行。host 因此会留下无人认领的 pty 与 watcher，直到整个 app 退出：

- 每个泄漏 pty 是一个活着的 shell 进程（Windows 上还带 conhost）；
- 每个泄漏 watcher 是一个 `ReadDirectoryChangesW` 句柄 + 防抖 timer；
- 唯一兜底是 host 退出时的 `disposeAll()`，而 host 生命周期远长于单个窗口。

`terminalService` 的内存诊断注释（`terminals.size` 只增不减）记录的正是这个现象。

## 规则

1. **owner 是 RPC 连接**，不是 host、不是窗口。同一 host 内多个 attachment（多窗口、手机远控、
   远程 workspace）各自独立。
2. `terminal.create` 与 `fileWatcher.watch` 创建的 id 登记到**发起该调用的连接**。
3. 连接销毁（`MessagePort` close → `handle.dispose()`）时，批量释放该连接登记的 id，
   并清空登记表。
4. 释放是幂等的：UI 已主动 `dispose` / `unwatch` 的 id 从登记表移除，连接销毁时不再重复处理。
5. 不改变 RPC 协议：不新增通道、不新增方法签名。回收走 host 侧包装，`services` 接口不变。
6. 其他连接不受影响：连接 A 的回收不得触碰连接 B 创建的资源。

## 所有权与路径

```
renderer(window A) ──MessagePort──► exposeServicesOnMessagePort
                                    ├─ overrides: Proxy(terminal), Proxy(fileWatcher)
                                    │    create/watch → 记录 id 到本连接的 Set
                                    │    dispose/unwatch → 从 Set 移除
                                    └─ handle.dispose()
                                         └─ 批量释放 Set 内剩余 id
```

单一所有者：**连接**（`exposeServicesOnMessagePort` 的 `handle`）。登记表是连接私有的，不进
`ServiceCollection`，也不跨连接共享。

## 失败语义

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 窗口关闭 | pty / watcher 留在 host 直到 app 退出 | 连接 dispose 时释放 |
| renderer 刷新 / 崩溃 | 同上 | 同上（`port.once("close")` 触发） |
| UI 主动关闭终端 / 停止 watch | 立即释放 | 不变 |
| 释放时 pty 已退出 | `dispose` 抛 "Terminal not found" | 包装层吞掉并 `warn`（幂等） |
| host 整体退出 | `disposeAll()` | 不变（仍保留兜底） |

## 边界

- 不覆盖 `disposeAll()`：那是 host 退出路径，保持现状。
- 不改变 remote workspace 的 scoped services 语义：包装层只做登记，不感知服务来自本地还是远程。
- 不做「断连后自动重建 pty」：renderer 重连后由 UI 重新 `create`，与刷新语义一致。
