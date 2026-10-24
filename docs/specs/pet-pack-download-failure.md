# 宠物包下载：输出流的 error 必须先有消费者

## 背景

`writeResponseBody`（`packages/desktop/src/main/pet/downloadPack.ts`）把响应体写进
`pack.zip`，原来是手写循环：

```ts
const output = createWriteStream(zipPath);
try {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!output.write(chunk.value)) await once(output, "drain");
  }
} catch { ... } finally {
  output.end();
  await finished(output).catch(() => {});
}
```

`output.on("error")` 只在 `finally` 的 `finished(output)` 里才被挂上。`await once(output,
"drain")` 确实会在 error 时 reject，但它只有在 `write()` 返回 `false` 时才执行。

`write()` 返回 `true`（缓冲区未满，小 chunk 必然如此）而写盘错误异步到达时，`'error'`
事件没有消费者 —— Electron **main 进程**收到未捕获异常直接崩溃。典型触发：`ENOSPC`
（磁盘满）、`EACCES`（目录权限变更）、Windows 上被安全软件/索引器锁住文件。

连带两个问题：

1. `response.body` 的 reader 不被 `cancel()`，底层连接与缓冲悬着；
2. 外层 `downloadPetPack` 的 `catch` 里 `rmSync(dest, { recursive: true })` 在 Windows 上
   会因为 `pack.zip` 句柄尚未关闭抛 `EBUSY`，把真实的 `network` 原因掩盖成 `missing-config`。

## 状态所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 输出流 | 一次 `writeResponseBody` 调用 | 该调用结束（正常或失败）之前必须已 destroy 且 close |
| fetch body reader | 同一次调用，包在源生成器里 | 由 `pipeline` 负责终止（正常读完或失败时都调用 `return`/`throw`） |
| `received` / `onProgress` | 同一次调用 | 与输出流同寿 |

## 规则

1. **输出流的 error 消费者必须在流创建后立即存在。** 不得依赖"稍后某个 `finished()`
   会给它挂监听"。
2. **任何一方失败必须销毁另一方。** 输出流失败时取消 reader；reader 失败/abort 时销毁
   输出流。用 `stream.pipeline` 表达这条，而不是手写 `once(drain)`。
3. **必须等输出流 close 之后上层才能 `rmSync(dest)`。** 否则 Windows 上句柄占用会把
   失败原因变成 `EBUSY`。
4. **错误映射保持不变**：abort 原样抛 `AbortError`；已是 `PetPackDownloadError` 的原样抛；
   其余一律映射成 `PetPackDownloadError("network")`。
5. 下载过程中的 `MAX_PACK_BYTES` 检查仍按累计 `received` 判定（不能依赖
   `content-length`，它可能缺失或撒谎）。

## 接口

`writeResponseBody(url, zipPath, options)` 签名不变；新增 `node:stream` 的 `Readable` 与
`node:stream/promises` 的 `pipeline` 依赖，移除不再需要的 `once`。

## 验收场景

1. **写盘中途失败**：注入一个 `write` 抛 `ENOSPC` 的输出流 → 抛
   `PetPackDownloadError("network")`，进程不崩，`pack.zip` 已关闭（随后 `rmSync` 成功）。
2. **超上限**：读完累计超过 `MAX_PACK_BYTES` → 抛 `("too-large")`，输出流被销毁。
3. **abort**：`signal` 在下载中触发 → 原样抛 `AbortError`。
4. **正常完成**：文件字节数与响应体一致，`onProgress` 收到递增的 `received`，
   最后一次的 `received === total`。
5. **响应体缺失**：`response.body` 为 `null` → 抛 `("http", status)`（既有行为不变）。

## 未覆盖

- `extractZip` 的条目流失败时不会 destroy 正在 `pipe` 的写流（本轮审计 P2-16）。
  同一个根因（失败路径不销毁对端），但涉及改动解压循环的状态机，单独处理。
- 解压后的 `rmSync` 重试策略。
