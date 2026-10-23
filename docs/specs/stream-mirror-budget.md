# stream mirror 批次预算：用增量计数代替重复序列化

## 背景

`desktop/src/main/taskRealtimeBus.ts` 负责把 Agent 的流式事件镜像给 observer host。
批次大小有两道预算，两处实现都在做**无意义的序列化**。

### 单批上限：`JSON.stringify` 只为读 `.length`

```ts
if (JSON.stringify(event).length > STREAM_MIRROR_MAX_BATCH_BYTES) {   // :530
```

把最大 512KB 的批次序列化成完整 JS 字符串（V8 里 1 字符 2 字节），只为读长度，结果立刻丢弃。
紧接着 `deliverStreamBatch`（`:735`）对每个 host `postMessage`，Electron 侧还要结构化克隆
一次 —— 同一份数据编码两遍。每个 run 每秒一次，并发 run 各算各的。

### replay 窗口：`while` 里整表重算（O(n²)）

```ts
while (this.replayBytes(batch.replay) > STREAM_MIRROR_MAX_REPLAY_BYTES) {
  batch.replay.shift();                                          // :758-759
}
private replayBytes(replay) {
  return replay.reduce((t, e) => t + JSON.stringify(e).length, 0); // :763-764
}
```

每 `shift()` 一个元素就重新 stringify 剩余全部。最坏 60 × 60 次 stringify、单次 flush
十几 MB 无用编码。

## 规则

1. **预算判断用增量计数，不重新序列化。** 队列在入队时累加、出队时扣减，维护一个
   `bytes` 字段。任何时候需要判断"是否超预算"，用这个字段而不是重算。
2. **`JSON.stringify(x).length` 不是字节数，也不是可靠的负载度量。** 它既低估（非 ASCII
   在 UTF-8 下更长）、又付出完整编码成本。需要度量时用 `Buffer.byteLength` 或直接累加已知的
   字段长度（`event.content?.length`）。
3. **预算字段与队列必须同生命周期。** 计数是队列的派生状态，任何 `push` / `shift` /
   `splice` / 清空都必须同步更新，否则计数会漂移。把它封装成一个小类（`push` / `shift` /
   `clear` 三个方法），不要散在调用点上。
4. **主进程不做可避免的大字符串分配。** Electron main 承载所有窗口的 IPC，一次 MB 级
   分配会波及全应用的响应延迟。

## 验收场景

- 单批 512KB 的 stream mirror，`flushBatch` 不再产生 `JSON.stringify` 调用
  （用 profiler 或临时计数断言）。
- replay 窗口推到 60 条且超预算 → shift 到符合预算为止，stringify 调用次数为 **0**。
- 队列计数与实际内容一致：随机 push/shift 序列后，`bytes` 等于逐条求和。
- 长 run（10 分钟、每秒一次 flush）期间 main 进程无明显 GC 尖峰。
