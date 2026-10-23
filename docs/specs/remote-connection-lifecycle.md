# 远程连接生命周期：跨进程资源必须有超时回收

## 背景

`packages/server/src/http.ts` 的 Web 模式用一张表暂存"已建立但浏览器还没接管"的远程连接：

```ts
const remoteConnections = new Map<string, RemoteConnection>();   // :155
```

写入在 `POST /api/connect-remote`（`:388`），**唯一**删除点是 `GET /ws/remote/:id` 的懒消费
（`:414`）。

value 不是一个小对象：`{ services, client, dispose }` 背后是一条 ssh / wsl / docker 远端
`zcode-server` 子进程。所以「POST 成功但浏览器没连 WS」这一条路径泄漏的是
**内存 + 子进程 + 管道 fd** 三者。

这条路径很普通：刷新页面、双击、导航被打断、探针/脚本重复调用都会命中。Web server 是常驻
的，于是孤儿远端进程只增不减。

## 状态所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| `RemoteConnection` | 一次「建立连接」请求，直到被 WS 接管 | 握手完成 → 被 `GET /ws/remote/:id` 消费，**最长存活 `REMOTE_CONNECTION_PENDING_TTL_MS`** |
| 远端子进程 | 所属 `RemoteConnection` | 随 `connection.dispose()` 结束 |

## 规则

1. **跨进程资源的暂存必须有 TTL。** 只要一张表的 value 持有子进程、socket、fd 或 worker，
   就不能依赖"调用方随后会来取" —— 调用方可以永远不来。TTL 到期即 `dispose()` + `delete`。
2. **失败路径必须回滚。** `createRemoteBackend()` / `connectRemote()` 抛错时，已经建立的
   部分必须自己收掉，不能等 TTL（TTL 是兜底，不是正常路径）。
3. **WS 接管后所有权转移。** `GET /ws/remote/:id` 拿到 connection 后立刻 `delete`（现有行为
   正确），此后由 WS 关闭路径负责 `dispose()`。TTL 不能再生效。
4. **TTL 定时器必须 `unref()`。** Web server 的退出不能被这个兜底定时器拖住。
5. **WS 关闭后必须 dispose（所有权终点）。** 接管时 `delete` 只是移出暂存表，不是释放；
   `connection.disposeAndWait()` 挂在 `upgradeWebSocket` 的 `onClose` 上。

6. **进程退出不显式清表。** `http.ts` 返回的是 `serve()` 的 Server，没有同步的关闭钩子，而
   `disposeAndWait()` 是异步的，`process.on("exit")` 里做不了。退出路径依赖：TTL 定时器已
   `unref`（不阻止退出）+ 远端进程在 stdio EOF 后自行结束。这是已知限制，不是遗漏 ——
   若要更彻底，需要把 `createHttpServer` 的返回值换成带 `{ close() }` 的句柄。

## 参数

- `REMOTE_CONNECTION_PENDING_TTL_MS = 60_000`：一次远程连接从握手完成到浏览器接管，
  合理上限是「用户点击后加载页面的时间」。60s 足够覆盖慢网络，又不会让废弃连接活太久。

## 验收场景

- `POST /api/connect-remote` 成功后不打开 WS → 60s 后 `remoteConnections` 为空，且远端
  子进程已退出（`ps` 无残留）。
- `connectRemote()` 抛错 → `remoteConnections` 无该条目（不依赖 TTL）。
- WS 正常接管 → 关闭 WS → `remoteConnections` 无该条目，子进程已退出。
- 建立 50 次废弃连接 → 内存与进程数回到基线（不累积）。
