# `picode_subagent` 后台派发

## 背景

`picode_subagent` 是同步的：`host-capabilities.ts` 的 `execute` 直接
`await input.runSubagent(profile, task, signal)`，工具不返回，Pi 的 agent loop 就不会发起
下一轮请求。主代理因此只能在**同一轮**里靠批次并发（`pi-agent-core` 默认
`toolExecution: "parallel"`）一次性派出多个子代理，然后一起等。

Pi 提供了后台派发的原语：`AgentSession.sendCustomMessage(message, { triggerTurn, deliverAs })`
（`pi-coding-agent/dist/core/agent-session.d.ts`）。streaming 时排队，空闲时 `triggerTurn`
直接开新 turn。`process` 工具已经在用同一套机制，所以后台进程能"派出去继续干活"。

协议和 UI 也已经预留：`toolCallRowSchema.backgrounded` / `subagentRowSchema.backgrounded`
存在，UI 按 `row.backgrounded !== true && status === "running"` 判断某行是否阻塞 turn 完成；
`live-subagents.ts` 的 `subagentControlWorks()` 能把 running 子会话产成可单独 Stop 的
`kind: "subagent"` backgroundWork。

缺的只是 pi-host 侧：没有后台分支，没有完成通知。

## 状态所有者

**`pi-host/src/subagent-background.ts` 的 runner**，作用域是单个父会话。

- 它持有本会话在跑的后台子会话集合（`Map<token, { childSessionId?, abortRequested }>`）。
- 它负责并发计数、占位、通知、取消。
- `live-subagents.ts` 的 `running` 表**保持进程内全局**，不参与后台生命周期判定：那张表是
  "谁还活着"，面板和 Stop 用它；它不是"哪个父会话派了谁"。因此不新增
  `abortAllLiveSubagents()`——全局表做不到按会话隔离，多窗口会互相误杀。

`runZcodeSubagent` 只负责在子会话建立后回调真实 `childSessionId`（`onStarted`），不持有
任何后台状态。

## 参数契约

```ts
picode_subagent({
  agent: string;                    // 必填，角色名
  task: string;                     // 必填，完整任务
  run_in_background?: boolean;      // 缺省 false，现有同步语义不变
})
```

- `false` / 缺省：`execute` 等到子代理给出最终答案，返回该文本。与今天完全一致。
- `true`：`execute` 在子代理**启动后**立即返回一段说明文本，不含子代理正文。
  说明文本不携带 `childSessionId`：`createAgentSession` 是异步的，`execute` 返回时 id 还不存在。

后台分支**不把父工具的 `AbortSignal` 传给子代理**：工具已经返回，signal 的语义到此为止。
取消只走两条路：

1. 状态面板 Stop → `abortLiveSubagent(childSessionId)`（已有）。
2. 父会话 `dispose` → runner 的 `abortAll()`。

`gateTool` 仍在 `execute` 里同步执行。需要用户批准的派发会先阻塞等批准，批准后才返回。
后台语义是"批准后立即返回"，不是"绕过批准"。

并发上限每会话 6 个在跑。超限直接返回错误文本，不启动子会话、不排队。

## 通知格式

子代理 settle 后，runner 调 `notify(text)`，由 `session-factory` 落成一条 custom message：

```ts
live.sendCustomMessage(
  { customType: "picode_subagent_result", display: true, content: text },
  { triggerTurn: true, deliverAs: "followUp" },
)
```

- `display: true` 是必需的：`jsonl-history.ts` 只把 `display !== false` 的 `custom_message`
  回放成消息，否则历史里看不到结果。
- `deliverAs: "followUp"`：父会话 streaming 时排到当前 turn 之后，空闲时立即开新 turn。
- 投递失败（会话已关闭）静默吞掉，不改变子代理结果。

正文形状：

```
子代理 "<agent>" 已完成（success | failed | cancelled）。
childSessionId: <id>
<正文，超过 16 KB 截断并标注>
```

`failed` 带错误文本；`cancelled` 不带正文。三种状态都发，否则模型会永远等一个不会来的结果。

状态归类靠 `runZcodeSubagent` 的两个返回值字面量，二者从 `host-capabilities.ts` 导出
（`SUBAGENT_CANCELLED_TEXT` / `SUBAGENT_FAILED_PREFIX`），不在两个模块各写一份。已知代价：
一个恰好以 `subagent failed:` 开头的**成功**正文会被归类成失败。

**幂等**：一次派发只 settle 一次，闭包里的 `settled` 布尔即令牌。手动 Stop 让
`session.prompt` 抛错或提前返回，走的是同一个 settle 路径，因此不会出现
"取消通知 + 完成通知"两条。`settled` 先于 `notify` 置位，所以 `notify` 自己抛错也不会二次通知。

**关闭**：`abortAll()` 同时把 runner 标记为 closed。之后 `start()` 直接拒绝（返回“会话正在关闭”），
`settle()` 跳过投递——否则结果会被塞进一个正在关闭的会话，甚至起一轮无人收听的请求。

## 取消路径

| 触发 | 行为 |
| --- | --- |
| 面板 Stop | `abortLiveSubagent(id)` → 子会话 `abort()` → 走 settle → `cancelled` 通知 |
| 父会话 `dispose` | `runner.abortAll()`：已拿到 id 的直接 abort；还没拿到 id 的占位标 `abortRequested`，`onStarted` 落地时立即 abort；同时关闭投递 |
| 子代理自己失败 | settle → `failed` 通知 |
| 进程被杀 | 无通知。与 `process` 工具同级，不做跨进程恢复 |

`session.abort()` 在没有 activeRun 时是 no-op。所以 `runZcodeSubagent` 在 `await session.prompt`
**之前**也要检查一次取消——否则“子会话刚建好就被关闭”这条路径会照常跑完整轮，
最后只报告成“已取消”。

## 验收场景

1. `run_in_background: true` 时，`execute` 在子代理给出答案前返回。
2. 返回文本含角色名与"后台"语义，不含子代理正文。
3. 子代理成功 / 失败 / 取消，各只发一条通知，状态正确。
4. 第 7 个并发派发被拒绝，且没有启动子会话。
5. `abortAll()` 只影响本 runner 派出的子代理。
6. `abortAll()` 发生在 `onStarted` 之前时，真实 id 一到就立刻 abort，仍只通知一次。
7. 缺省参数仍走同步分支，返回值与今天一致。
8. 超过 16 KB 的正文被截断并带标注。
9. 子代理结果在实时对话里以一条正文行出现（不必重载）。
10. 后台派发的工具卡摘要行带“后台”角标；同步派发不带。

## 实时与回放口径

结果在 live 与重载后必须长得一样：

- **live**：`projector.ts` 把 `role: "custom"` 且 `display !== false` 的 `message_start`
  画成 `assistantText` / `complete` 行（`appendCustomMessageEvent`）。
- **回放**：`jsonl-history.ts` 把同一条 `custom_message` 合成 `role: "assistant"` 的消息。
- `display: false`（如 ui-design 的提醒）只进上下文，不占画面。

## 后台角标

后台分支在工具结果里带 `details.backgrounded: true`；`projector.toolEnd` 把它写到
`ToolCallRow.backgrounded`（协议字段本来就有，只是一直没人设置）。

UI 侧：`toolCallRowToLegacyNode` 桥接成 `raw.backgrounded`，`readSubagentBackgrounded` 读它，
`SubagentToolCallBlock` 据此给摘要行挂一个 `kindDetail` 角标（`chat.toolCall.subagent.background`）。
角标只说“这次派发是后台的、结果稍后到”，不表示“还在跑”。

## 不做的

- `get_subagent_result` 之类的 pull 工具：通知已带正文，第一版不做拉取。
- 并发排队：超限直接拒绝，不维护等待队列。
- 跨进程恢复：后台子代理是进程内状态。
