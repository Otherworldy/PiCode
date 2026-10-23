# RPC 请求异常隔离

## 背景

`ChannelServer` 在 socket / MessagePort 的 `data` 回调里同步解析请求并分发到 service channel。
`ProxyChannel.toService` 把任意 `on*` 属性访问都翻译成 `channel.listen(...)`，而
`ProxyChannel.fromService().listen` 对未知事件名直接 `throw new Error("Event not found")`。
`Emitter.fire` 也没有 try/catch。

结果是：**客户端订阅一个服务上不存在的事件名，异常会一路冒到 `data` 回调**，host 进程的
`uncaughtException` 处理器随即 `disposeHostResources` + `process.exit(1)`。同一窗口下的全部
会话、全部 workspace 一起退出，且旧版本客户端 / 手机 web / 条件分支里取值都可能触发。

## 规则

1. `onRawMessage` 是 RPC 服务端的**异常边界**：任何一帧处理失败都不得冒泡到协议层的
   `onMessage` 回调之外。
2. 请求可识别（header 携带 number 类型 id）时，失败必须转成该请求的 `PromiseError` 响应，
   让客户端 promise 正常 reject —— 不允许让客户端永久挂起。
3. 请求不可识别（帧损坏、header 解析失败）时丢弃该帧，只记录日志。
4. 已成功注册的监听、已存在的 `activeRequests` 条目不受本次失败影响：单个坏请求不清理
   其他请求的状态。
5. 修复不改变成功路径：合法请求的分发顺序、响应格式、超时与取消语义保持不变。

## 失败语义

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 订阅不存在的事件名 | 异常冒泡 → host `process.exit(1)` | 回 `PromiseError`，host 存活 |
| `channel.call` 同步抛（已有处理） | 回 `PromiseError` | 不变 |
| 帧解析失败 / 损坏 | 异常冒泡 → 进程退出 | 丢弃该帧 + 日志 |
| `disposeActiveRequest` 抛 | 异常冒泡 | 回 `PromiseError`（若有 id） |

## 边界

- 只覆盖 `ChannelServer` 的入站分发。出站方向（`sendResponse`）已有 try/catch，不改。
- 不引入重试：失败即失败，由客户端决定是否重发。
- 不改变 `channelClient` 的 handler 生命周期语义（那是独立缺陷，另行处理）。
