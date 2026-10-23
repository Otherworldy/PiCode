# 工具输出预算：磁盘与内存的双重边界

## 背景

Agent 的工具输出有两个独立的上限：**模型看到多少**（inline 上限，通常 30–256KB）和
**落到磁盘/内存多少**（persisted 上限）。审计发现后者的两个实现都有洞。

### bash：5 GiB 上限 + 5 秒轮询

`core/src/tool/handlers/bash.ts:71` 定义 `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 GiB`，
子进程 stdout 直接接管成普通文件 fd，Node 侧完全不看字节数。唯一的刹车在
`adapters/src/exec/bash-file-output.ts:65-87`：

```ts
const timer = setInterval(() => { ... stat(this.path) ... if (file.size <= maxBytes) return; ... },
  OUTPUT_WATCH_INTERVAL_MS /* 5000 */);
```

三个问题：

1. **1 GB 输出不会触发任何限制。** 5 GiB 是"杀进程"的阈值，不是"这不该落盘"的阈值。
2. **5 秒轮询意味着可以超调**：写入速率 × 5s 的量在检测前已经落盘。
3. **没有 session 级合计上限。** 并发 N 个 bash 各有一份文件；
   `AggregatePersistedOutputBudget` 只在非 bash 的 pipe 分支生效。

另外 `cli/exec/<sessionId>/<toolCallId>-stdout.log` **全仓搜不到清理逻辑**（对比
`shell-init-snapshot.ts:196` 有 retentionDays）。磁盘只增不减。

### read：传了 `limit` 就没有字节上限

`core/src/tool/handlers/read-text.ts:47`：

```ts
maxBytes: limitProvided ? undefined : READ_MAX_FILE_SIZE_BYTES,
```

`text-range-reader.ts:38` 对 `undefined` 直接放行。于是 `read({path, limit: 1})` 读 2 GB
文件不做任何检查；流式分支为了算 `totalLines` 必须扫完整个文件，而没有换行的文件会把整行
塞进 `carry` —— 一个 2 GB 单行 minified JSON 会让 `carry` 涨到 GB 级。

反向也坏：`read({offset: 5000})` 不带 `limit` → `maxBytes = 256KB`，读 1 GB 日志的第 5000
行会以 `too_large` 失败。

## 规则

1. **两个上限正交，不能互相取消。** `limit`（行数）和 `maxBytes`（字节）是独立的约束，同时
   生效。任何"传了 A 就不检查 B"的写法都是漏洞。
2. **字节预算要在写入侧计量，不是轮询探测。** 轮询的间隔就是超调窗口；用
   `fs.createWriteStream` 的 `bytesWritten` 或自建计数在每次 write 前判断。
3. **聚合预算要覆盖所有输出形态。** bash 的文件直写和设备上的 pipe 收集必须共用同一个
   session 级额度，否则"并发 10 个命令"就是 10 倍泄漏。
4. **单行也要有上限。** 行数限制挡不住"一行 2 GB"。`maxLineBytes` 触发时截断该行并标记
   `firstLineExceedsLimit`（Pi 的 `truncateHead` 已有这个语义）。
5. **落盘目录必须有 retention。** 任何按会话/工具调用生成的文件，都要有按时间或总量的清理，
   与 `shell-init-snapshot.ts` 的口径一致。

## 参数

| 常量 | 值 | 状态 |
| --- | --- | --- |
| `BASH_RUNTIME_OUTPUT_LIMIT_BYTES` / `MAX_RUNTIME_PERSISTED_OUTPUT_BYTES` | 512 MiB（原 5 GiB） | **已实现** |
| `MAX_RETAINED_LINE_CHARS`（`text-range-reader.ts`） | 8M 字符 | **已实现**：超限抛 `too_large`。选 8M 而不是 1M，是因为 minified bundle / 内联 sourcemap 的单行常有数 MB，卡太紧会把原来能读的文件变成直接失败。按契约 Node adapter 的 range read 选择失败而不是静默截断 |
| `MAX_SESSION_PERSISTED_OUTPUT_BYTES` | 2 GiB | **未实现**：需要一条 session 级 budget 传递路径。现在 `aggregatePersistedBudget` 只在单次 execute 内的多个 stream 之间共享，bash 完全没被覆盖（它拿的是文件 fd，不经过 `OutputCollector`） |
| `EXEC_OUTPUT_RETENTION_DAYS` | 7 天 | **未实现**：`cli/exec` 目录仍无清理 |

## 已知限制

- bash 的字节计量只能靠文件大小推断（子进程直接持有 fd），所以「检测到超限」总是晚于「已经写入」。
  已用 `fs.watch` + 250ms debounce 把窗口从固定 5s 压到一个事件周期，但不可能为零。
- 流式 read 为了报告 `totalLines` 仍需扫完整个文件；带 `limit` 读一个很靠后的 offset 依然是
  O(文件大小)。本轮只挡住了 OOM，扫描量本身没有优化。

## 验收场景

- `bash: yes | head -c 2000000000` → 命令在约 512 MiB 处被 `output_limit` 终止，磁盘只留
  该量级的文件。
- 同一会话并发 5 条各写 400 MiB 的命令 → 合计到 2 GiB 时后续命令被终止。
- `read({path: "2gb-oneline.json", limit: 1})` → 返回首行截断结果 + `truncated` 标记，
  不 OOM。
- `read({path: "1gb.log", offset: 5000, limit: 50})` → 成功返回 50 行（不再因 `maxBytes`
  报 `too_large`）。
- 落盘目录存在超过 7 天的文件 → 启动时被清理。
