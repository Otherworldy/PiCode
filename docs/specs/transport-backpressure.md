# 传输层背压与字节边界

## 背景

主机侧 `<->` 渲染侧的数据量在流式对话时是持续的：模型输出、工具日志、终端输出，每一路都是
「生产者比消费者快」的形态。三条链路各有不同的缺口：

1. **stdio NDJSON（CLI ↔ host）**：按 chunk `toString("utf8")` 解码，多字节字符跨 chunk 边界
   会被截成 `�`；`send()` 不看 `write()` 返回值、不等 `drain`，也不设本地队列上限。
2. **WebSocket（Web 远控 / 手机）**：`drain()` 直接返回已 resolve 的 promise（假 drain），
   服务端不知道客户端消费慢。
3. **pty → RPC**：`onData` 直接 `fire`，没有 `pause`/`resume`、没有字节配额。

## 规则

### 字节边界（必须做，数据损坏）

1. **凡是从流里按块读文本，必须用 `StringDecoder`。** `chunk.toString("utf8")` 会把落
   chunk 边界上的多字节字符切成 U+FFFD。host 侧 `zcodeStdioTransport` 已经用了，CLI 侧
   必须对齐——两个方向都是同一条 NDJSON 协议。
2. **解析失败必须带真实请求 id。** 现在的 `sendError("parse-error", ...)` 用的是字符串 id，
   与请求的 `pending` 表 key 对不上，只能等 3 分钟超时。

### 背压（按链路分别处理）

3. **`drain()` 必须是真 drain。** 判定口径是「`bufferedAmount` 降到阈值以下」，16ms 轮询，
   最长等 1s 后放行（流控不能把发送方卡死）。

   **不能用 `bufferedamountlow`**：`ws` 的 `WebSocket` 没有这个事件，也没有
   `bufferedAmountLowThreshold` 属性（只有底层 `net.Socket` 有 `'drain'`，而那表示内核缓冲
   排空，不代表 ws 自己的发送队列已空）。如果照着这个假信号写，有背压时每次 drain 都会整整
   等满超时。stdio 侧可以用 `writableNeedDrain` + `'drain'`，那是真的。
4. **`send()` 在 `write()` 返回 false 时必须能反压。** 具体形式按链路能力定：
   - 有 ACK 层的（`PersistentProtocol`）已有水位，不需要重复实现；
   - 无 ACK 层的（`SocketProtocol` / NDJSON）至少不能让本地写队列无界增长。
5. **pty 输出要有上限。** 刷屏命令（`yes`、`cat` 大文件）在 renderer 消费慢时会把 host
   utilityProcess 堆爆，host 挂了会带走整个窗口的所有服务，不只终端。

## 分阶段实施

背压涉及协议语义，一次全做风险太高。按「数据损坏 → 假信号 → 真队列」分三步：

- **第 1 步（本次）**：CLI 的 `StringDecoder` + 解析错误带 id。纯正确性，无协议变化。
- **第 2 步**：WebSocket `drain()` 改真实现。只影响「何时认为可以继续发」，不改帧格式。
- **第 3 步**：pty 字节配额与 `pause`/`resume`，以及 CLI `send()` 的本地队列上限。
  需要先确认：暂停 pty 会不会让前台进程阻塞在写系统调用上（shell 的可见行为会变）。

## 不做的事

不在协议层加通用流控握手。`PersistentProtocol` 已有 `unackBytes` 水位 + `onSaturated`/
`onDrained`，那是经过验证的一套；给 `SocketProtocol` 重建同样的机制是重复劳动，
真正缺的是「底层传输要诚实报告能否继续写」。

## 验证方式

- 中文/emoji prompt 跨 64KB 边界：CLI 收到的行能完整 `JSON.parse`，不出现 U+FFFD。
- 解析失败：客户端在 3 分钟内收到明确错误，而不是超时。
- WebSocket 慢客户端：`drain()` 在 `bufferedAmount` 降到阈值以下前不 resolve。
- 终端刷屏 + renderer 暂停：host 内存不随时间线性增长。
