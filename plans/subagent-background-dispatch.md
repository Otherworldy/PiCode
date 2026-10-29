# `picode_subagent` 后台派发

## Context

现在 `picode_subagent` 是同步的：`host-capabilities.ts:590` 直接 `await input.runSubagent(...)`，工具不返回，父会话不会发起下一轮请求。主代理因此不能在子代理运行时继续干活，只能在同一轮里靠批次并发（`pi-agent-core` 默认 `toolExecution: "parallel"`）一次性派出多个，然后一起等。

Pi 的扩展 API 提供了后台派发的原语，PiCode 里已经在用：

- `AgentSession.sendCustomMessage(msg, { triggerTurn, deliverAs })`（`pi-coding-agent/dist/core/agent-session.d.ts:611`）—— 就是 `pi.sendMessage` 的底层，streaming 时排队，空闲时 `triggerTurn` 直接开新 turn。
- `process` 工具就是靠这套机制（`notify: turn` 唤醒 / `context` 静默追加），所以后台进程能"派出去继续干活"。
- 协议和 UI 也预留了：`toolCallRowSchema.backgrounded` / `subagentRowSchema.backgrounded`（`packages/shared/src/zcode-protocol-v4/rows.ts:250,297`），UI 已按 `row.backgrounded !== true && status === "running"` 判断阻塞（`packages/ui/src/v4/conversationTurnRenderUnits.ts:194,200`）。
- `live-subagents.ts:113` 的 `subagentControlWorks()` 已经能把 running 子会话产成 `kind: "subagent"` 的 backgroundWorks，带单独 Stop。

缺的只是 pi-host 侧：工具没有后台分支，没人设置 `backgrounded`，也没有完成通知。

**目标**：`picode_subagent` 支持 `run_in_background: true`，立即返回，子代理跑完后把结果作为 custom message 推回主会话，主代理在等待期间可以继续做别的事。

**不在范围内**：`get_subagent_result` pull 工具、并发排队、跨进程恢复、UI 的"后台"角标。

## 现状证据

| 位置 | 内容 |
| --- | --- |
| `pi-host/src/host-capabilities.ts:549-553` | `runSubagent(profile, task, signal) => Promise<string>` |
| `pi-host/src/host-capabilities.ts:560-591` | 工具定义，参数只有 `agent` / `task`，execute 末尾 `await` |
| `pi-host/src/host-capabilities.ts:444` | `trackLiveSubagent(session.sessionId, ...)`，真实子会话 id 在这里才产生 |
| `pi-host/src/session-factory.ts:488-506` | `runSubagent` 闭包，能读到可变引用 `live` |
| `pi-host/src/session-factory.ts:794` | `dispose: () => (shuttingDown ??= shutdownPiSession(session))` |
| `pi-host/src/live-subagents.ts:26` | 进程内全局 `running` Map，key 是 childSessionId，**没有父会话信息** |
| `pi-host/src/jsonl-history.ts:275-284` | `custom_message` 且 `display !== false` 回放成 assistant 消息 |

`live-subagents.ts` 的 `running` 是全局表，所以**不能**加 `abortAllLiveSubagents()`：多窗口/多会话时会把别人的子代理一起停掉。按会话隔离由新模块的 runner 维护局部集合。

## Approach

状态所有者集中在**一个**新模块 `subagent-background.ts`（本会话作用域），`host-capabilities.ts` 只做参数转发，`session-factory.ts` 只做接线。理由：`session-factory.ts` 已经 797 行，超过仓库的 400 行上限，不能再往里塞生命周期逻辑。

1. 工具加可选参数 `run_in_background`（缺省 `false`，现有同步语义不变）。
2. `runSubagent` 的签名从 `(profile, task, signal?)` 改为 `(profile, task, options)`，`options` 带 `signal` / `background` / `onStarted`。
3. 后台分支的挂载、计数、占位、通知、取消列表全在新模块里；`runZcodeSubagent` 只增加 `onStarted?: (childSessionId: string) => void`，在 `trackLiveSubagent`（`:444`）处回调真实 id。
4. `session-factory` 构造 runner 并把它的 `run` 交给 `createCapabilityTools`，`dispose` 调 `runner.abortAll()`。
5. 后台子代理**不绑定父工具 signal**：工具已经返回，signal 的语义到此为止。取消只走两条路——面板 Stop（`abortLiveSubagent`，已有）和会话 `dispose`。
6. 返回文本不带 childSessionId：`createAgentSession` 是异步的，`execute` 返回时 id 还不存在。id 只在通知里出现，模型拿到通知后用它下钻。
7. `gateTool` 仍在 `execute` 里同步执行（`permission-gate.ts:31`）。需要用户批准的派发会先阻塞等批准，批准后才返回——后台语义是“批准后立即返回”，不是“绕过批准”。

### 时序

```
主代理 turn
  │  picode_subagent({ agent, task, run_in_background: true })
  ├─► gateTool → 找 profile → 上限检查 → 占位
  ├─► 启动 runZcodeSubagent（不 await）
  │      └─► child AgentSession 创建
  │            onStarted(childSessionId) ──► 集合换真 id
  │            trackLiveSubagent(id) ──────► backgroundWorks 面板可 Stop
  ├─► 立即返回 "started in background"
  │
  ├─► 批次 settle，主代理继续下一轮
  │
  └─► child 跑完（success / failed / cancelled）
         ├─ 集合删除 id
         └─ sendCustomMessage(triggerTurn: true, deliverAs: followUp)
               ├─ 主代理 streaming → 进 followUp 队列，agent 空闲时交付
               └─ 主代理空闲 → append + 开新 turn
```

通知只发一次：后台 promise 只 settle 一次，闭包里的 `settled` 布尔即幂等令牌。`abortLiveSubagent` 触发 `stopChild` → `session.abort()` → `prompt` 抛错或返回 → 同一个 settle 路径，发 `cancelled` 通知。

### 决策点（按推荐值写，不同意在审阅里改）

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| 默认值 | `run_in_background` 缺省 `false` | 不改变任何现有行为；同步语义仍是"我要最终答案" |
| 结果投递 | `display: true` 的 custom message，`customType: "picode_subagent_result"` | `jsonl-history.ts:275` 回放时显示为消息；`display: false` 会导致用户看不到结果 |
| 结果长度 | 截断到 16 KB，尾部标注截断 | 防止一次大报告把上下文打爆 |
| 并发上限 | 每会话 6，超限直接返回错误文本 | runner 自己计数，成本约 10 行；避免模型一次派 20 个完整 AgentSession |
| 失败通知 | 同样发通知，status `failed`，带错误文本 | 否则模型永远等一个不会来的结果 |
| 取消通知 | status `cancelled` | 同上 |

## Files to modify

- `apps/zcode-cli/packages/pi-host/src/subagent-background.ts` — **新增**：后台子代理的唯一所有者
- `apps/zcode-cli/packages/pi-host/src/subagent-background.test.ts` — **新增**：该模块的单测
- `apps/zcode-cli/packages/pi-host/src/host-capabilities.ts` — 参数、`runSubagent` 签名、`onStarted` 透传
- `apps/zcode-cli/packages/pi-host/src/session-factory.ts` — 构造 runner、接线、`dispose`
- `apps/zcode-cli/packages/pi-host/src/host-capabilities.test.ts` — 现有用例随签名调整
- `apps/zcode-cli/packages/pi-host/src/index.ts` — 若需要导出新模块（仅内部用则不加）
- `docs/specs/subagent-background-dispatch.md` — **新增** spec（先写）

不改：
- `live-subagents.ts` — 全局表结构不动，复用现有 `abortLiveSubagent` / `trackLiveSubagent`
- `packages/shared/**` — `backgrounded` / `workId` 字段已存在
- `packages/ui/**` — 后台行不阻塞完成的判定已存在；角标不在本方案

## Reuse

| 复用 | 位置 |
| --- | --- |
| `sendCustomMessage` 四种投递语义 | `pi-coding-agent/dist/core/agent-session.d.ts:611-620` |
| `trackLiveSubagent` / `abortLiveSubagent` | `pi-host/src/live-subagents.ts:30,105` |
| `subagentControlWorks` 面板 Stop | `pi-host/src/live-subagents.ts:113` |
| `textResult` 帮助函数 | `pi-host/src/host-capabilities.ts:256` |
| `custom_message` 历史回放 | `pi-host/src/jsonl-history.ts:275` |
| custom message 先例 | `pi-host/src/ui-design-mode.ts:34,206` |
| 小模块 + 纯函数的拆分先例 | `pi-host/src/model-delegate.ts`、`pi-host/src/live-subagents.ts` |

## Steps

- [x] 写 `docs/specs/subagent-background-dispatch.md`：状态所有者、参数契约、通知格式、取消路径、验收场景
- [x] 新建 `subagent-background.ts`，导出 `createBackgroundSubagents({ run, notify, maxConcurrent })`，其中 `run(profile, task, onStarted)` 就是包好 `onStarted` 的 `runZcodeSubagent`：
  - `start(profile, task)` — 上限检查 → 占位 → 启动 → 立即返回说明文本
  - `abortAll()` — 逐个 `abortLiveSubagent`；对还没拿到真实 id 的占位标 cancelled，`onStarted` 落地时立即 abort
  - `formatSettled(event)` — 纯函数，agent 名 + status + 截断到 16 KB 的正文
  - 幂等：`settled` 布尔，promise 只 settle 一次
- [x] `subagent-background.test.ts`：立即返回、通知一次、失败/取消也通知、超限拒绝、`abortAll` 只停自己的、`abortAll` 早于 `onStarted` 时仍能停
- [x] `host-capabilities.ts`：`runSubagent` 签名改为 `(profile, task, options)`；工具参数加 `run_in_background`；后台时 `options.signal` 不传
- [x] `host-capabilities.ts`：更新 `description` / `promptGuidelines`，明确"后台派发不要轮询，结果会以消息到达"
- [x] `host-capabilities.ts`：`runZcodeSubagent` 增加 `onStarted`，在 `:444` 的 `trackLiveSubagent` 处调用
- [x] `session-factory.ts`：`live` 的类型放宽到能调 `sendCustomMessage`；构造 runner；`dispose` 先 `abortAll()` 再 `shutdownPiSession`
- [x] 更新 `host-capabilities.test.ts` 里现有 `runSubagent` 调用签名
- [x] 跑 `pnpm --filter @zcode/pi-host test`、`pnpm typecheck`、`pnpm lint`
- [ ] 跑 `pnpm architecture:check --changed`

## Verification

**单测**（`pnpm --filter @zcode/pi-host test`）

`subagent-background.test.ts`：

1. `run()` 在 `run` 的 promise 还没 resolve 前就返回。
2. 返回文本包含 agent 名与"后台"语义，且不含子代理正文。
3. 子代理成功 → `notify` 收到一次，status `success`，正文完整。
4. 子代理抛错 → `notify` 收到一次，status `failed`。
5. `abortAll()` 后 → `notify` 收到一次，status `cancelled`，不重复。
6. 超过 6 个在跑 → 第 7 个直接返回错误文本，不启动子会话。
7. `abortAll()` 只停本 runner 的 id，不影响别的 runner。
8. `abortAll()` 发生在 `onStarted` 之前 → 真实 id 一到就立刻 abort，仍只通知一次。
9. 正文超过 16 KB → 截断并带标注。

`host-capabilities.test.ts`：

10. 缺省参数走同步分支，返回子代理最终文本。
11. `run_in_background: true` 时 `options.background` 为 `true`，`options.signal` 为 `undefined`。

**手动**（`pnpm dev:desktop`）

1. 让主代理一轮派 3 个 `run_in_background: true` 的子代理，确认工具行立即完成、主代理继续下一步。
2. 状态面板出现 3 条 running 的 subagent work，点 Stop 能单独停掉一条，并收到 cancelled 通知。
3. 子代理完成时，主代理在空闲状态下被唤醒，收到结果消息；streaming 状态下结果排在当前 turn 之后。
4. 关闭会话时有子代理在跑 → 子代理被取消，无未处理异常。

## 风险

- **进程内状态**：`running` 表在进程里，进程被杀时后台子代理既不会跑完也不会通知。`dispose` 只覆盖正常关闭。可接受，与现有 `process` 工具同级。
- **通知风暴**：一次派 6 个，若几乎同时完成，会产生 6 条 followUp。Pi 的 `followUpMode` 默认 `all`，可能合并成一轮，模型要一次读 6 份结果。上限 6 就是为此设的。
- **结果丢弃**：会话在子代理完成前被关掉，`sendCustomMessage` 会抛错，`.catch` 吞掉，结果丢失。这与"关掉会话"的用户意图一致。
- **`backgrounded` 不设置**：工具行在 execute 返回时就是 success，`isCompletionBlockingWorkRowRunning` 不会误判阻塞，所以功能正确；只是 UI 没有“后台”角标，留作后续。
- **权限阻塞**：派发需要用户批准时，`execute` 会在 `gateTool` 里等，主代理此时仍不能继续。这是有意的——批准不能被后台化。
