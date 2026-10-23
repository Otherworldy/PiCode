# MCP App 工具调用的额度

## 背景

插件页面（MCP App）通过 `mcp/uiCallTool` 调用宿主工具。审计发现这条路径**没有任何额度**：

- `bootstrap/src/zcode-protocol/mcp-ui/handlers.ts:36-37` 的 `activeUiToolCalls` /
  `finishedUiToolCalls` 是模块级 Map，每个 callId 永久写入（`:148-154`）。
- `:88-90` 只做 callId 去重，没有并发上限、没有超时、没有单会话次数上限。
- 清账本只发生在实例 lease abort（`mcp-ui/protocol.ts`）和 session 关闭
  （`server-operations.ts`）。

对照 `mcp-ui/samplingCalls.ts:57-62`：同样性质的调用有
`MCP_APPS_SAMPLING_MAX_PER_AGENT / PER_SESSION / MAX_OPERATIONS` + 超时。**同一个目录里两个
handler，一个有额度一个没有。**

后果：一个被攻陷或本身恶意的插件页面可以

```
for (;;) invokeTool(`call-${n++}`)
```

让 CLI 进程内存无界增长（每个 callId 一条 + 每个在途调用一个 AbortController），
同时把上游 MCP server 打爆。

## 额度模型（照抄 samplingCalls 的形状，不发明新概念）

| 额度 | 值 | 触发后的行为 |
| --- | --- | --- |
| 每实例并发 in-flight | 4 | 超出的请求立即 reject（`MCP_APP_UI_CALL_CONCURRENCY`），不进队列 |
| 每会话累计调用数 | 500 | 超出 reject（`MCP_APP_UI_CALL_MAX_PER_SESSION`） |
| 单次调用超时 | 120s | abort + reject（`MCP_APP_UI_CALL_TIMEOUT_MS`） |
| 终态账本容量 | 512 | FIFO 淘汰（去重只需要覆盖最近的 callId） |

## 规则

1. **额度按「实例」而不是「会话」计并发。** 一个会话可以挂多个 App，某个 App 死循环不能
   挤掉同会话里其它 App 的调用。
2. **超限要立即拒绝，不要排队。** 恶意调用方只会把队列填满；排队把内存问题换成延迟问题。
3. **超时必须走 AbortController。** 工具执行本身可能尊重 signal（bash/grep 都尊重），
   abort 能让上游真的停下，而不只是让宿主不再等。
4. **终态账本必须有界。** 去重的语义是「同一个 callId 不重复执行」，只需要覆盖
   「可能被重发的窗口」（秒级）。512 条 FIFO 足够。
5. **拒绝要带可区分的错误码。** `MCP_UI_CALL_CONCURRENCY_EXCEEDED` /
   `MCP_UI_CALL_QUOTA_EXCEEDED` / `MCP_UI_CALL_TIMEOUT`，让插件开发者能从日志判断
   是自己写错了还是撞了限额。

## 验收场景

- 一个页面同时发起 10 个 `uiCallTool`：4 个执行，6 个立刻收到
  `MCP_UI_CALL_CONCURRENCY_EXCEEDED`。
- 一个会话累计 501 次调用：第 501 次收到 `MCP_UI_CALL_QUOTA_EXCEEDED`。
- 工具实现挂住（永不 resolve）：120s 后调用方收到 `MCP_UI_CALL_TIMEOUT`，且工具的 signal
  已 abort。
- 完成 2000 次调用后：`finishedUiToolCalls.size <= 512`。
- 正常使用（一个 App 顺序调用 20 次）：全部成功，无额度干扰。
