# 工作区文件搜索 Worker：崩了必须真的降级

## 背景

`createWorkerWorkspaceFileSearchFilterBackend`（`packages/ui/src/
workspace-file-search/workspaceFileSearchFilterBackend.ts`）把候选打分放进 module worker，
主线程只负责传 packed 字符串和等结果。文件头注释明确写了降级设计：

> 同步实现保留两个用途：(1) **Worker 不可用/运行失败的降级路径**，行为与历史版本一致；
> (2) 单测环境（Node 下无 Web Worker）注入。

但 `worker.onerror` 只做了「让在途请求过期」：

```ts
worker.onerror = (event) => {
  logger.warn("[workspace-file-search] Worker 运行失败，本轮过滤结果丢弃", ...
    // 注释原文：「后续 filter 仍会重试」
  );
  for (const [, waiter] of pending) waiter.resolve(null);
  pending.clear();
};
```

**「后续 filter 仍会重试」这个前提是错的。** `worker_threads` / Web Worker 在未捕获异常
之后自身已经终止，此后 `worker.postMessage(...)` 是静默 no-op。于是：

- `filter()` 继续 `pending.set(seq, ...)` 并 `postMessage` 到死 worker → 该 Promise **永不
  settle**，`@` 面板永久停在 loading；
- `pending` 只增不减，每敲一个字符泄漏一个永远不会被 resolve 的闭包（只有 `dispose()`
  才清）；
- 搜索过滤功能静默失效，没有任何用户可见的错误。

`onerror` 之后 worker 引用也不能再被复用，它已经是一个死句柄。

## 状态所有者

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| `worker` | 一次 backend 实例 | 创建时或 `onerror` 后置 `null`；`dispose()` 时 terminate |
| `fallback`（同步实现） | 同一次实例 | 首次降级时惰性创建；与 backend 同寿 |
| `packedState`（最近一次 `setPacked` 的入参） | 同一次实例 | 每次 `setPacked` 覆盖；降级时用来重放 |
| `pending` | 同一次实例 | `onerror`、`setPacked`、`dispose` 三个点批量清空 |

backend 实例的生命周期由 `useWorkspaceFileSearchFilterEntries` 的 `useRef` 持有，
hook 卸载时 `dispose()`。因此降级只影响**当前挂载期**；下次打开 `@` 面板会重新尝试
创建 worker。

## 规则

1. **`onerror` 必须让 worker 进入终态。** terminate 掉死句柄并清空引用，不能让后续
   `postMessage` 打到死 worker 上。
2. **进入终态后所有公开 API 一律走同步降级实现**（`setPacked` / `filter` / `dispose`）。
   降级实现不是"另一条并行的路径"，而是终态之后唯一实现。
3. **降级时必须重放最近一次 `setPacked` 的候选**，否则 `filter` 会在空候选上返回空数组 ——
   对调用方表现为"文件搜索突然搜不到任何东西"。
4. **不重建 worker。** worker 崩掉通常是 packed 数据或运行环境的问题，同实例内重建会立刻
   再崩一次；重建的语义由「hook 重新挂载」提供，不需要在实例内做重试状态机。
5. **`dispose()` 幂等**：无论当前处于 worker 态还是降级态都可以调用，且不再抛错。
6. 降级时要 `logger.warn` 一条，说明「已切到主线程同步过滤」——这是性能退化，必须留痕。

## 接口

`WorkspaceFileSearchFilterBackend` 接口不变（`setPacked` / `filter` / `dispose`），调用方
无感知。`filter` 的既有契约不变：**永不 reject**，过期结果解析为 `null`。

内部新增：`fallback: WorkspaceFileSearchFilterBackend | null`、`packedState: { packed,
rootPath } | null`、`degrade()` 闭包。

## 验收场景

1. **崩前有在途请求**：`onerror` 触发 → 在途 `filter` 解析为 `null`（不是 hang）。
2. **崩后再 filter**：结果正确（走同步实现），`filtering` 能正常结束。
3. **未 `setPacked` 就崩**：后续 `filter` 返回 `[]`（降级实现无候选），不抛错。
4. **`setPacked` 之后崩**：降级实现拿到重放的候选，`filter` 返回与 worker 态一致的结果。
5. **`setPacked` 发给死 worker 不再发生**：崩之后的 `setPacked` 只写 `packedState` + 喂
   fallback。
6. **`dispose()` 之后调用不抛**：`onerror` 晚到、`dispose` 之后再 `filter` 都不产生异常。

## 未覆盖

- Worker 偶发崩溃后的自动重建（本 spec 明确不做，见规则 4）。
- 同步降级的性能（37 万候选下每键 50-300ms）——那是降级的固有代价，用「功能可用」
  换「性能」。
- `workspaceFileSearchFilter.worker.ts` 内部异常的具体成因诊断（只做降级，不做归因）。
