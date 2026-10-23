# Git checkpoint 冲突检测的批量 hash

## 背景

`restoreBetweenCheckpoints` 在写入前要确认「restore 将触达的这些路径，当前磁盘内容是否仍等于
调用方声明的 fromCheckpoint」。判定方式是逐个比较 blob hash（不比较时间戳/大小，只认内容）。

原实现对**每个**受影响文件单独跑一次：

```
git hash-object --no-filters <absolutePath>
```

两个叠加的代价：

1. **进程开销**。Windows 上每次 spawn 15-40ms。
2. **共享串行队列**。`gitCommandProvider` 按 cwd 串行（这是有意的：Windows 上并行 status/diff
   会把大仓库 index 同时扫进内存，Git helper/filter 也会拖住句柄）。所以这些 spawn 不仅慢，
   还会把同一仓库的**所有** git 命令堵在后面——状态栏刷新、diff 面板、自动刷新一起卡住。

一次 agent turn 改 100 个文件时，`collectWorkspaceConflicts` 会在恢复前置检查与恢复后校验两处各跑一遍，
实测量级 200 次 spawn ≈ 4-8 秒 git 全线停顿。1000 个文件时 40-80 秒。

## 规则

1. **用 `git hash-object --stdin-paths` 一次处理全部路径。** 它从 stdin 读换行分隔的路径列表，
   每条输出一行 hash，**顺序与输入一致**。实测中文路径正常（git 按 UTF-8 读 stdin）。
2. **批量失败要退回逐文件。** 只要有一个路径读不了，git 会 `fatal` 中止（exit 128），
   已处理的输出保留。这种情况下逐文件重试，保持「hash 失败即报错」的原有语义——
   异常路径退化回旧行为，正常路径不再 spawn N 次。
3. **输出顺序必须稳定。** 冲突列表顺序由 `affectedRepoPaths` 决定，上层按它展示。
   批量化不能改变顺序：用「索引占位数组 + 遍历填充」而不是「先收非 hash 冲突、再收 hash 冲突」。
4. **入批前判定路径能否被行协议表达。** `--stdin-paths` 不是纯字节流：首字符 `"` 的行会被
   `unquote_c_style` 解引用，行尾 `\r` 会被 `strbuf_getline` 吃掉。命中这两种路径时 git 会去
   hash **另一个**文件，而且 exit 0、行数不变 —— 「内容已经变了」被静默判成「没变」，
   restore 随后覆盖用户的真实改动。任一不可表达的路径就让整批退回逐文件，
   不做 partition 后拼回（索引重排容易再引入错位）。
5. **两个上限都要按规模放宽。** 输出是每行 40 字符 hash，默认 `maxOutputBytes = 512KB`
   约 1.3 万个路径就会截断 → 进程被杀 → 白跑一次再退回串行；超时同理（整批共享一个预算，
   不按路径数放宽会把正常的大批量误判成超时）。
6. **回退必须有日志。** 批量超时、被截断、fatal 三种原因都要落一条 `warn`，否则现场只能看到
   「restore 又慢了」或者一条指向逐文件调用的误导性超时错误。
7. **孤儿批量不许立刻回退。** `orphaned` 说明上次 taskkill 没杀死进程、队列已被污染，
   紧接着的逐文件调用会被 `previousGitCommandStillRunning` 直接判成超时（命令根本没启动），
   把「上次批量孤儿」误报成「本次 hash 超时」。此时直接报错，不进逐文件循环。
8. **stdin 是可选能力。** `GitCommandExecutionOptions` 新增 `stdin?: string`，只在传了的时候
   才把子进程 stdin 接成 pipe。git 可能在我们写完之前就退出（路径不可读直接 fatal），
   所以 stdin 上必须挂一个吞掉 `EPIPE` 的 error 监听。

## 不做的事

不并发化 `pathExists` / `lstat`。这些是异步 stat，100 个文件总量在毫秒级，不是瓶颈；
而把它们并发化会让顺序控制复杂化，收益与风险不成比例。

也不改 `gitCommandProvider` 的按 cwd 串行语义。串行是为了避免大仓库并行扫描的内存峰值，
批量 hash 把 N 次排队压成 1 次，已经解决了阻塞问题的根源。

## 验证方式

- 100 个改动文件：git 队列上只出现 1 次 `hash-object`，restore 前置检查耗时从秒级降到百毫秒级。
- 内容一致时不报冲突；内容不一致时报 `content-mismatch`，且冲突顺序与 `affectedRepoPaths` 一致。
- 人为在 lstat 之后删掉一个文件 → 批量 fatal → 逐文件回退 → 得到与原实现相同的错误。
