# 浏览器下载监听：共享 Session 上的监听器归属与清理

## 背景

`browserGuestManager` 为每个 browser tab 注册 `will-download` 监听（`setupDownloadTracking`），
用于把下载项转成 `DownloadRecord` 并唤醒 `waitForDownload` 的等待者。

清理路径原来写成：

```ts
// Electron 会在 renderer 卸载 <webview> 时先销毁 guest；此时 listener 已随对象释放，
// 再调用 session.removeListener 只会产生无意义的 "Object has been destroyed" 日志。
if (!guestDestroyed) tab.downloadCleanup?.();
...
finally { tab.downloadCleanup = undefined; }
```

**这条注释的前提是错的。** `guest.session` 不是 guest 私有的：所有内置浏览器 tab 共用
`partition="persist:zcode-embedded-browser"`（`packages/ui/src/browser-use/BrowserViewportSurface.tsx`，
main 侧同名常量在 `browserDataManager.ts`），而 Electron 对同一 partition 字符串返回**同一个
Session 对象**，其生命周期与进程一致。guest 销毁不释放 Session，因此：

1. listener 留在共享 Session 上，不会被回收；
2. `tab.downloadCleanup = undefined` 销毁了唯一的移除句柄 → 此后**没有任何路径**能移除它；
3. 残留 listener 的 `contents !== guest` 守卫只能阻止误处理，挡不住监听器本身累积；
4. 死 tab 的 `downloadId` 仍会被 push 进 `queuedDownloads`，而该 tab 已不再被消费。

## 状态所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| `will-download` listener | 一个 tab 的一次 `setupDownloadTracking` 调用 | 下一次 `setupDownloadTracking`（guest 换代）或 `detachGuest` |
| `Session` 对象 | Electron 的 partition 缓存 | 进程生命周期，**与 guest 无关** |
| `downloadCleanup` | `ManagedTab` | 由 `setupDownloadTracking` 设置，`detachGuest` 无条件消费 |
| `destroyed` 监听 | `attachGuest` 的首次接线 | guest 自身；不参与 `isSameGuest` 门内的重建 |

## 规则

1. **清理闭包必须持有被监听对象本体，不能靠宿主反查。** `downloadCleanup` 捕获
   `setupDownloadTracking` 里取到的 `session` 常量，不写 `guest.session`。这样 guest 销毁后
   闭包仍然可用，`removeListener` 是纯 JS 侧操作，不依赖任何 native 句柄。
2. **监听对象不随宿主销毁时，清理不能以宿主存活为前提。** 判断依据是"谁持有 listener"，
   不是"宿主还在不在"。共享 Session 上的监听必须无条件移除。
3. **清空清理句柄前必须先执行它。** `finally { tab.downloadCleanup = undefined }` 这个结构
   本身没问题，但不能被一个可能为假的条件挡住 —— 一旦跳过，句柄丢失即永久泄漏。
4. **`catch` 是防御分支，失败必须 warn 级留痕。** 按规则 1 闭包不触达 guest，正常不会抛。
   真抛出来说明约定被打破（例如有人改回 `guest.session.removeListener`），而 `finally`
   仍会置空句柄 —— 泄漏被原样复现。这条路只能用 `warn`（`debug` 生产不落盘）。
5. **只注册一次的监听不能被重复 attach 累积。** `guest.once("destroyed")` 不参与
   `isSameGuest` 门内的四个 setup 重建，因此它自己也要有同名门条件。renderer 在切 tab /
   scope 变化时会重复上报同一个 guest（`UnifiedBrowserView` 只在 guest+active+scope 全同时
   去重），不设门条件就按 attach 次数累积。
6. **泄漏面必须可观测，且要暴露真正泄漏的那个对象。** tab 级 Map 的 size 只是其中一半；
   本轮泄漏的是**共享 Session 上的 listener**，所以 `collectMemoryDiagnostics()` 必须报
   `willDownloadListeners`（`session.listenerCount("will-download")`）。

## 接口

```ts
// setupDownloadTracking 内部
const session = guest.session;
if (!session) return;
this.downloadSession = session;              // 仅用于诊断计数
session.on("will-download", listener);
tab.downloadCleanup = () => session.removeListener("will-download", listener);

// detachGuest
try {
  tab.downloadCleanup?.();
} catch (error) {
  this.warn(`detachGuest download cleanup failed tabId=${tab.tabId}`, error);
} finally {
  tab.downloadCleanup = undefined;
}
```

`collectMemoryDiagnostics()` 返回的键：

- tab/scope 级 Map（11 个）：`tabs`、`closedTabIds`、`downloads`、`queuedDownloads`、
  `downloadWaiters`、`waiters`、`runningRequests`、`recordings`、`inFlightScreenshots`、
  `sessionNames`、`visibilityByScope`。
  注意 `sessionNames` / `visibilityByScope` 的 key 是 `scopeKey()`，报的是 **scope 数**
  而不是 tab 数，不要当 tab 计数用。
- 共享 Session：`willDownloadListeners`。

## 验收场景

- 挂载 guest → 打开 tab → suspend（renderer 卸载 `<webview>`，guest 先销毁）→ 恢复 tab：
  共享 Session 上的 `will-download` 监听器数量**不增长**。
- 连续 100 次 tab suspend/restore 后，`willDownloadListeners` 恒等于当前 attached 的
  browser tab 数。
- 稳态下 `willDownloadListeners` 不超过 `BROWSER_TAB_LIMIT`（32）。**不承诺**「不出现
  `MaxListenersExceededWarning`」：tab 数 > 10 时单 Session 上的监听数超过 Node 默认
  `maxListeners`，这是"每 tab 一条监听"的既有设计，不是泄漏。判定泄漏看的是「数是否随
  suspend/restore 单调增长」。
- tab 关闭 → `detachGuest` 在 `guest.isDestroyed() === true` 的情况下仍然执行
  `removeListener`（原实现在这里跳过）。
- 一次下载事件只被**当前代际**的 listener 处理一次；残留 listener 不再把 `downloadId`
  写入已关闭 tab 的 `queuedDownloads`。
- 关闭所有 tab 后，`downloads` / `queuedDownloads` / `downloadWaiters` / `waiters` 归零，
  `willDownloadListeners` 归零。
- 同一 guest 重复 attach 5 次（切 tab 来回）后，该 guest 上 `destroyed` 监听仍为 1 条。

## 已核对同类模式（本轮结论）

`browserGuestManager` 内其余监听都挂在 **guest 自身**（`render-process-gone`、
`debugger.on("message")`、`activity` 五个、`item.once("done")`），随对象回收，清理也已无条件
（前两个）或按 `guestDestroyed` 跳过（activity，正确 —— 它的闭包捕获 guest，guest 销毁后
回调会真抛）。`pluginSandbox/session.ts` 的 `session.on(...)` 用 `WeakSet` 按 Session 去重，
数量上限是插件数量，不属于本模式。**没有第二处同样的错误注释。**

## 未覆盖（下一步独立处理）

- `closeWindow` 与 `closeTab` 的清理不对称（`downloads` / `queuedDownloads` /
  `downloadWaiters` / `waiters` / `sessionNames` / `visibilityByScope` 在快速关窗路径上
  不清理）；`disposeAll` 在生产无调用方。本轮只修监听器归属与可观测性，关窗清理需要
  先把 `scopeKey` 收敛到窗口维度，否则删不干净。
- `pendingDialogs` / `abandonedScreenshotCaptures` / `suspendAckWaiters` 同样是可泄漏的
  tab 级 Map，尚未纳入诊断。
