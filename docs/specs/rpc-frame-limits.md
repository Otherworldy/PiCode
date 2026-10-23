# RPC 帧与反序列化的输入边界

## 背景

`packages/rpc` 的二进制协议跑在多种传输上：stdio（host ↔ CLI）、进程内 queue，以及
**Web 远控的 WebSocket**（`packages/server/src/http.ts` 直接 `new SocketProtocol(socket)`）。
最后一条意味着协议帧来自网络，不能假设对端可信或实现正确。

修之前有两处缺失：

1. **帧长无上限**。`SocketProtocol.readMessages` 与 `PersistentProtocol` 都从帧头读
   `length = readUInt32BE(9)` 后直接把它当目标长度去等整帧到齐。一个 13 字节的帧头写上
   `0xFFFFFFFF`，再持续灌数据，`ChunkStream.chunks` 会无界增长到进程 OOM。
2. **反序列化不检查截断**。`deserialize` 读 `Array` 时，元素个数来自 wire，越界读返回空
   Buffer 而不是报错，于是 `for (i < length) result.push(undefined)` 会空转数亿次。

## 规则

1. **帧长必须有上限。** 上限取 `MAX_FRAME_BYTES = 64MiB`。依据：rpc 层承载的最大合法载荷是
   文件预览的 25MiB base64（`fileService` 的硬上限）与几 MB 的截图 PNG，64MiB 留了余量，
   同时远低于能打爆进程的量级。
2. **超限即断连，不尝试恢复。** 帧长超限后，字节流的帧边界已经不可信，继续解析只会把
   后续数据解释成垃圾帧。此时丢弃缓冲，并**关掉底层 socket**（`socket.dispose()`）：
   只做协议对象自己的 `dispose()` 不行——它只摘自己的监听，上层 `SocketServer` 依赖
   `socket.onClose` 清理 `ChannelServer` 和连接登记，不关 socket 的话这条连接会一直挂着。

   **stdio 传输是例外**：`wrapStdioStream.dispose()` 只 `end()` stdin，能否让上层收到 close
   取决于远端进程在 EOF 后是否退出（ssh 半开时可能永不触发）。所以协议层自己也要兜住写后置 ——
   `SocketProtocol.writeMessage` 在 `disposed` 后直接 return，避免 write-after-end 变成
   uncaughtException（host 侧会 `process.exit(1)`）。

   对 `PersistentProtocol` 还要显式 fire `onSocketClose`：`RemoteAgentConnection` 的重连订阅
   挂在这个事件上，而超限路径**不能**调 `dispose()`（它会把订阅一起拆掉，连接永久哑掉、
   pending 永不 settle）。超限只处理一次（`frameLimitFired` 护栏 + 先摘 onData），否则对端持续
   发坏帧会在 socket 真正 close 之前反复 fire，每次都从 attempt 0 重连，退避形同虚设。
   `replaceSocket` 复位 `overflowed` / `frameLimitFired`，否则一次超限会把标记永久打上。
   `abandonSession` 同时清空重放队列 —— 不清的话这些条目会带着原 `queuedAt` 重放到新连接，
   ackCheck 一看到超过宽限窗就再次 abandon，反而给刚恢复的新会话发一帧 Disconnect。
3. **不发异常到上层事件循环。** `readMessages` 在 socket 的 `onData` 回调里同步执行。
   抛错会冒泡成 `uncaughtException`，而 `host/index.ts` 对 `uncaughtException` 的处理是
   `process.exit(1)` —— 单帧损坏会带走整个 host 的所有会话。所以边界内自行收口。
4. **反序列化把截断当错误。** `readIntVQL`、类型字节、以及四个载荷分支（String / Buffer /
   VSBuffer / Object）在读取长度不足时立即抛错。`BufferReader.read` 越界时会按 clamp 返回
   短 buffer，不逐个校验的话 `[0x01][len=100]"abc"` 会安静地解出一个短字符串。
5. **VQL 保持 32 位有符号语义。** 编码侧 `writeInt32VQL` 对负数同样输出 5 字节，读取侧必须
   读回负数，否则 `-1` 会变成 `4294967295`。「长度不可能为负」的字段（数组元素个数）自己
   检查 `length < 0`，不能靠把读取侧改成无符号来兜。
6. **数组元素个数有独立上限。** 即使帧长合法，一个声明了 4G 个元素的空数组也能让循环空转；
   元素个数上限与帧长上限是两道独立的闸。

## 不做的事

不引入「帧长协商」或「分片」机制。rpc 层没有分片概念，v4 wire 层才有（`wire-assembler.ts`
的 `maxFrameBytes = 1MiB`）；需要传大对象时由上层自己切分，协议层只负责拒绝超限帧。

## 验证方式

- 发送 `length = 0xFFFFFFFF` 的帧头 + 少量数据 → 连接被 dispose，进程存活。
- 发送一帧 body 为 `[0x04][VQL 极大值]` 的空数组 → 反序列化抛错，不空转。
- 正常大帧（如 20MiB 文件 base64）仍能通过。
