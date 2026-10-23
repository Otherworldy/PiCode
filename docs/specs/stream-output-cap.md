# 流式输出上限：`streamOutputCapBytes` 的落地

## 背景

`packages/shared/src/zcode-protocol-v4/core.ts` 在 `DELIVERY_PROFILES` 里声明了
`streamOutputCapBytes`：

```ts
continuous: { streamOutputCapBytes: 262144 }   // :44
replayable: { streamOutputCapBytes: 0 }        // :56
```

`grep -rn "streamOutputCapBytes"` 全仓（含 `dist`）只命中这三行定义，**`packages/ui` 与
`apps/zcode-cli` 零引用**。也就是说「单行流式输出最多下发 256 KB」这条护栏从来没接线。

`projector.appendStream`（`pi-host/src/projector.ts`）只看 `streamPaths` 这个布尔开关，
不看字节数。后果是单行（一次 `assistant` 文本行、一次工具 `output.text`）可以无上限增长，
每帧整行下发 + 整行重渲染。

**声明了但没生效的护栏比没有护栏更危险**：下一个改这块的人会以为它存在。

## 决策

**本轮未落地。** 实现后经复核发现，在当前的 `ConversationRow` 契约下无法安全截断：

- `session-registry.ts` 的 `navigateTree` 用 `row.text` 作为**匹配键**去 `resolveEntry`，
  assistant 行没有兜底，截断后直接抛 `Entry not found`。
- `v4-gateway.ts` 用 `extractMarkdownArtifactImageRefs(row.text)` 判定 artifact 图片归属，
  cap 之后的引用扫不到，长消息里的图片会失去授权。

也就是说「下行截断」必然让服务端的 `row.text` 不完整，而它有两个依赖完整内容的读者。
要安全落地，需要先扩展契约（`ConversationRow` 增加 `truncatedChars`，UI 侧独立渲染提示），
让截断只影响 presentation 而不影响数据字段。

**方向仍然确定：落地，不删除。** 理由：

- 上界确实需要。一条被截断的流式行仍然可读（用户能看到开头 + "已截断"），
  而一条无上限增长的行会让 33 Hz 的帧越来越重。
- `continuous` 与 `replayable` 的差异是真实的：桌面走连续流，手机走可重放恢复，
  后者需要完整内容才能在重连后重放。所以 `0`（无上限）对 replayable 是有意义的。

## 规则

1. **上限按 `profile` 生效，作用于「单行的累积字符数」。** 超过之后继续接收事件，但不再往
   网络层追加正文，改为维护一个 `truncated` 标记与已省略的字符数。
2. **截断必须可见。** 下行要带 `outputTruncated: { omittedChars: number }`（或等价字段），
   UI 才能显示「已省略 N 字符」。静默截断会让用户以为输出真的只有这么长。
3. **截断不影响持久化。** 会话 jsonl 仍然写完整内容 —— 上限只约束 wire，不约束磁盘。
   否则重放会丢数据，且「截断」变成永久损失。
4. **`0` 表示不限。** replayable profile 保持无上限；不要把 `0` 当成「什么都不下发」。
5. **上限的判断在 append 点做一次，不做每帧重算。** 累积值 += 本帧增量，与 cap 比较。

## 实现位置（待做）

1. `ConversationRow`（`shared`）增加可选的 `truncatedChars`；`apply` 的 `row.delta` 支持写入它。
2. `Projector.appendStream` 按 rowId 记账（不能用一个共享字段：assistantText 与 reasoning 是
   两条可并行的流，共享计数会让其中一条被另一条重置）。
3. 截断只作用于 delta 的 `append`，`row.text` 仍保留完整内容 —— 或者让所有依赖完整内容的
   读者改走 jsonl。
4. UI 在行尾渲染「已省略 N 字符」，不写进 `text`。

## 验收场景

- continuous profile 下模型输出一条 1 MB 的单行：wire 上该行的正文停在 256 KB，
  后续帧只更新 `truncatedChars`；jsonl 里仍是完整 1 MB。
- replayable profile 下同样输入：wire 上是完整 1 MB（上限为 0）。
- UI 收到截断行：显示「已省略 N 字符」（不是静默变短）。
- 截断发生后再来新帧：不重新下发前面 256 KB（已经发过）。
