# 存储启动的无进展看门狗

## 背景

Desktop 启动时要等两个异步阶段完成，两者都是「子进程/worker 报阶段，main 侧等终态」的形状：

| 阶段 | 等待方 | 子进程 |
| --- | --- | --- |
| tasks-index 迁移 | `packages/desktop/src/host/storagePreparationProcesses.ts` `prepareHostStorage` | Worker |
| session 库迁移 | 同文件 `runSessionStorageWorker` | Worker（带 3 次重试） |
| Agent 进程的 SQLite 启动 | `packages/services/src/zcode-agent/zcodeStorageStartupGate.ts` | Agent 子进程 |

三处都有同一个缺陷：**首个状态帧到达就 `clearTimeout`，之后再没有任何定时器**。

```ts
// zcodeStorageStartupGate.ts（改造前）
constructor(required, firstStatusTimeoutMs = 30_000) {
  if (required) { this.ensurePending(); this.timer = setTimeout(() => this.fail(...), firstStatusTimeoutMs); }
}
accept(input) {
  ...
  clearTimeout(this.timer);      // 首帧之后永不再装
  ...
}
```

于是「进程活着、首帧已到、之后不再发帧」的场景没有出路：

**Gate 侧（`zcodeStorageStartupGate.ts:22-28`、`:51`、`:86-94`）**
- `isWaiting` 恒为 true，`zcodeProtocolClient.ts:142` 的 `await this.storageStartup.wait()` 永久挂起 ——
  该 workspace 之后**每个** `request()` 都停在栅栏前。
- 因为 `wait()` 在创建请求 pending **之前**，请求级超时建立不起来；
  `zcodeProtocolClient.ts:307-310` 还会在首帧到达时清掉**已在飞**请求的 timeout，而
  `resumeTimeout()` 只在 `phase === "ready"` 时调用（全仓唯一调用点 `:309`）。
- `requestTimeoutEmitter`（`:161`）是 owner 淘汰 stale runtime 的唯一信号，此时不会 fire。
- `zcodeAgentProcessManager.ts:1124` 与 `:644-648` 用 `isWaiting` 判断是否清 idle timer ——
  `isWaiting` 在 `terminalError` 存在时也为 true，所以即使失败也永不回收进程。

**Worker 侧（`storagePreparationProcesses.ts:73-76`、`:89-90`、`:99-104`；`:257-260`、`:276`、`:319-321`）**
- `firstStateTimer`（30s）在首个 message 后被清，之后只有 `worker.once("exit")` 能结算。
- worker 发出 progress 后卡在 SQLite 调用里（锁、IO）→ `prepare()` / `runSessionStorageWorker()`
  **永不 settle** → `DatabaseStartupCoordinator.run()` 的 `finally { running = false }` 不执行 →
  `databaseStartupCoordinator.ts:63-65` 的 `retry()` 因 `this.running === true` 直接 return，
  **用户点重试无效**；`host/index.ts` 的 `pendingStartupAttachments` 也不会 flush
  （只在 `ready` 时 flush）。

## 状态所有者

| 状态 | 所有者 |
| --- | --- |
| 「多久没进展算卡死」 | `packages/shared/src/database-startup.ts` 的 `STORAGE_STARTUP_STALL_TIMEOUT_MS` |
| Gate 的无进展计时 | `ZCodeStorageStartupGate` 私有 stall timer |
| Worker 的无进展计时 | `prepareHostStorage` / `runSessionStorageWorker` 各自的 stall timer |
| 是否已失败 | `ZCodeStorageStartupGate.failed` getter |

## 规则

1. **每个「阶段式」等待都必须有两个定时器**：一个是「首个状态」超时（快速失败，30s），
   另一个是「无进展」看门狗（`STORAGE_STARTUP_STALL_TIMEOUT_MS`，每收到一个非终态状态帧
   就 `refresh()`）。只有前者的话，首帧一到就再无出路。
2. **无进展看门狗衡量的是「两个状态帧之间的最大间隔」，不是单次操作耗时。** phase 帧只在
   阶段变化时发送（迁移不逐行上报），所以这个值必须明显大于最慢的单阶段迁移，取 180s；
   不能用请求超时（30s 量级）代替，否则大库正常迁移会被误杀。
3. **终态必须 disarm。** `ready` / `failed` / `dispose` 三个出口都要停掉看门狗，否则它会在
   正常完成之后误触发一次 `fail()`，把已就绪的 gate 打成失败。
4. **`isWaiting` 不能单独用作「不该回收进程」的判据。** `isWaiting` 在 `terminalError` 存在时
   仍为 true（这是为了拒绝后续请求），但此时**已经放弃该进程**，必须允许 idle 回收。
   判断条件写成 `isWaiting && !failed`。
5. **`terminalError` 必须在 `changed.fire()` 之前落位。** `Emitter.fire` 是同步的，监听者
   （`zcodeAgentProcessManager` 的 `publishStorage`）在失败通知里**马上**读 `failed` 来决定
   是「继续等」还是「安排 idle 回收」。顺序反了它会读到 `failed === false`，走进 clear 分支
   —— 而看门狗恰恰只会走这条本地 `fail()` 路径（不发 `failed` 帧），于是卡死的进程永远
   不会被回收。这是规则 4 能不能成立的前提，不是风格问题。
6. **`waiting_for_lock` 阶段必须暂停 stall 计时。** tasks / session 两个库的锁等待预算都是
   **60 分钟**（`tasksDatabase/startup.ts` 的 `LOCK_WAIT_MS`、`migration-runner.ts` 的
   `DEFAULT_SQLITE_MIGRATION_WAIT_MS`），而 `waiting_for_lock` 只上报一次、之后整段等待零帧。
   不暂停会把「等锁 60 分钟后报 `lock_timeout`」改写成「180 秒后报 `startup_status_timeout`」——
   常规多窗口场景就会命中，不是极端情形。
7. **Worker 侧的 30s 首帧超时保留。** worker 根本没起来（entry 缺失、spawn 失败）应该在
   30s 内失败，不必等 180s。首帧之后由看门狗接管。
8. **超时/中止必须直接结算，不能只 terminate 等 `exit`。** `worker.terminate()` 抢占不了
   worker 里阻塞中的**同步原生调用**（`node:sqlite` 的 `exec/prepare` 都是），这类卡点永不返回
   时 `exit` 也不来。只 terminate 的话 Promise 仍然永挂、`coordinator.running` 仍然永真，
   第二个症状根本没闭合。代价是可能出现「已 reject 但 worker 未退出、仍持锁」的短窗口。
9. **`dispose()` 要有 disposed 标记。** `required=false` 的 gate 从无 `pending`，`dispose()`
   不会置 `terminalError`；不挡住迟到帧的话，`accept()` 会重新装一个看门狗、让 `isWaiting`
   变回 true，把已放弃的进程重新算成「还在等」。

## 接口

```ts
// packages/shared/src/database-startup.ts
/**
 * 存储启动/准备阶段的「无进展」上限（两个状态帧之间的最大间隔）。
 * phase 帧只在阶段变化时发送，所以不能用请求超时量级的值。
 */
export const STORAGE_STARTUP_STALL_TIMEOUT_MS = 180_000;

// ZCodeStorageStartupGate
get failed(): boolean;            // terminalError 是否存在
private armStallTimer(): void;    // clear +（waiting_for_lock 时早退）+ setTimeout(..., MS) + unref
private disarmStallTimer(): void;
```

`accept()` 的时序：

```
首帧（非终态）  -> clearTimeout(firstStatusTimer) + armStallTimer()
后续非终态帧    -> armStallTimer()（续期）
ready          -> resolve + disarmStallTimer()
failed         -> fail() + disarmStallTimer()
dispose()      -> fail("transport_closed") + disarmStallTimer()
```

三处的共用核心是 `packages/shared/src/progressWatchdog.ts` 的 `createProgressWatchdog`：

```ts
const watchdog = createProgressWatchdog({
  firstFrameTimeoutMs: 30_000,
  stallTimeoutMs: STORAGE_STARTUP_STALL_TIMEOUT_MS,
  pausesStall: (phase) => phase === "waiting_for_lock",
  onTimeout: () => settleWith(statusError("startup_status_timeout")),
});
// 每个状态帧：watchdog.noteFrame(phase)
// 终态出口：watchdog.dispose()
```

Gate 保持自己的实现（phase 驱动、ready/failed 分支更直接），但同样遵守上面 9 条规则。

## 验收场景

- Agent 进程发出 `startup/storageState`（phase = `preparing_*`）后不再发帧：
  `STORAGE_STARTUP_STALL_TIMEOUT_MS` 之后 `wait()` 抛 `SQLite startup failed: startup_status_timeout`，
  该 workspace 的后续 `request()` 立即失败而不是永久挂起。
- 同一场景下 idle 回收仍然生效：stall 触发后 `publishStorage` 与 idle timer 回调都不再因
  `isWaiting` 而阻断回收。
- 正常慢迁移不误杀：持续收到 phase 帧时看门狗持续续期，永远不会触发（用假 timer 推进
  `2 × STORAGE_STARTUP_STALL_TIMEOUT_MS` 且中途有帧，断言 `failed === false`）。
- gate 进入 `ready` 之后，看门狗不再触发 `fail()`（推进超出阈值后 `failed === false`）。
- Storage worker 发出首个 `progress` 帧后卡住：看门狗 terminate worker，`prepare()` reject，
  `DatabaseStartupCoordinator` 的 `running` 复位，`retry()` 可用。
- worker 从头不响应：30s 首帧超时仍然生效（不被 180s 看门狗掩盖）。

## 未覆盖（记录为后续项）

- **`zcodeProtocolClient.ts:307-310` 的 timeout 暂停/恢复语义未改。** 现在靠 gate 的看门狗
  兜底（超时后 `terminalError` 让 `wait()` 抛错），而不是恢复在飞请求的计时器。`resumeTimeout`
  仍只在 `phase === "ready"` 时调用。
- **Host 侧不主动发心跳。** 看门狗只依赖现有的「阶段变化帧」。如果一个阶段本身就超过 180s
  （超大库单次迁移），仍会误报。彻底解决需要 Host 在迁移过程中定期发等相位帧（sequence 递增），
  属另一项改动。
- **`runSessionStorageWorker` 的 3 次重试叠加。** 每次 attempt 各自持有一个看门狗，最坏情况下
  `startup_status_timeout` 不满足 `shouldRetrySessionStorageWorker`（要求 `kind === "transport_closed"` 或 `EBUSY/EPERM/EACCES/EPIPE/UNKNOWN` 且 `storageWorkerBeforePath === true`），所以 stall 超时第一次就抛出，最坏是一次 180s 而不是 3×180s。
- **`prepareSessionStorage` 的 `observePath` 预算（250ms/路径）** 与看门狗无关，未改。
- **`packages/desktop/src/main/zcodeDataSizeWorkerClient.ts:32-59` 是同族缺陷**：等单个 worker 的
  唯一终态消息，只有 abort / error / 非 0 退出的 exit 能结算，**没有任何超时**。worker 内部的
  `maxDurationMs: 30_000` 是在 Worker 自己的循环里计时，worker 卡死时该预算同样不生效。
  症状轻（遥测旁路），未在本轮修。
- **已 reject 但 worker 仍在跑的窗口。** 规则 8 的直接结算意味着调用方可能在 worker 尚未退出、
  仍持有 SQLite 锁时就开始重试或继续启动。当前接受这个取舍（另一个选择是永久悬挂）。


- **chat lane 在 gate 失败后不会回收进程。** `ZCodeAgentProcessManager` 的 idle 回收需要
  `idleTimeoutMs > 0`，而 chat / plugin 两条 lane 根本不传这个值（只有 mcp-status 传），因此
  规则 4 的「允许 idle 回收」对它们不生效。又因为 `zcodeAgentService.ts` 的
  `isReusableActiveClientEntry` 只检查 `isDisposed`，一个 storage 启动失败的 client 会被当成
  可复用 —— 该 workspace 之后每次 RPC 都直接报 `SQLite startup failed: ...`，直到进程自己死掉
  或应用重启。要真正自愈需要「gate 失败 ⇒ 淘汰该 client 并终止进程」的完整路径（谁终止、
  如何等待、是否影响其他 workspace），本轮未做。
- **未上报的锁等待仍会误报。** `maintaining` 之后的 `repo.ensureReady()` 也用 `LOCK_WAIT_MS`
  （60 分钟）做 `busy_timeout`，但**不发 `waiting_for_lock` 帧**；若它真的阻塞超过 180s，仍会
  被判成 `startup_status_timeout`。同理单条超大迁移语句执行期间也算「无帧」。