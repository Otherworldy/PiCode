# `@` 文件补全的搜索预算

## 背景

`mentions/providers/fileMentionProvider.ts` 的 `useEffect` 依赖 `query`，而上游
`MentionPlugin` 用的是 `useDeferredValue` —— **那不是 debounce**：React 只要这次渲染没有
被打断，就会逐个提交每个中间值。于是补全面板打开期间，**每按一个键**发一次
`searchWorkspaceFiles` RPC。

更重的是无命中路径（`:73-77`）：查不到结果时再发一次 `refresh: true`，而
`fileService.ensureWorkspaceFileIndex` 对 `refresh` 是绕过 in-flight 去重的（`:371`）：

```ts
if (!refresh && inFlight?.signature === cacheSignature) return inFlight.promise;
```

`refresh: true` 直接起一轮完整 DFS `readdir`。仓库自己的注释（`fileService.ts:382`）记着：

> 37 万文件的 Windows workspace 实测 21.8s

而 `lastMissQuery` 是**单值**不是集合：输入 `abcd` 全部无命中时会依次补扫 `a`、`ab`、
`abc`、`abcd` —— 每个字符一次 21 秒级的全仓遍历，**且并发不合并**。这个扫描跑在 Host 进程
里，也就是正在跑 Agent 的同一个 node 进程。

## 规则

1. **用户输入驱动的远端搜索必须 debounce。** `useDeferredValue` 解决的是渲染优先级，不是
   请求节流；两者不能互相替代。query → RPC 之间要有 150–250ms 的静默期。
2. **`refresh`（强制重建索引）不能挂在"无命中"这类高频路径上。** 它是 O(工作区文件数) 的
   全量 DFS，只能由明确的用户意图触发（打开面板的首次加载、手动刷新按钮）。
3. **"这次没命中"的记忆必须能容纳整个输入过程。** 单值 `lastMissQuery` 等价于"每个新 query
   都算新未命中"；如果保留补扫策略，至少要有界集合。
4. **取消要真的取消。** debounce 窗口内的旧请求在 effect cleanup 里失效即可（现有 `active`
   标志可用），但不要让它继续占着 Host 的扫描队列 —— 所以更要在发出前就节流，而不是发出后
   丢弃结果。
5. **加载态不能每次按键都重置。** 现有实现每次 effect 都 `setResult({ loading: true })`，
   配合 debounce 后应保留上一次的结果直到新结果到达，否则面板会闪。

## 参数

- `MENTION_QUERY_DEBOUNCE_MS = 200`
- 补扫策略：**移除**无命中时的 `refresh: true`。改为面板打开时（`enabled` 由 false 变 true）
  做一次 `refresh: true`，之后只用 TTL 内缓存。

## 验收场景

- 快速输入 5 个字符的查询 → 只发 1 次 RPC（debounce 生效）。
- 输入一个不存在的文件名 → 不再触发全仓索引重建；面板显示"无匹配"而不是卡住。
- 面板打开时工作区新增了文件 → 首次打开能看到（保留一次 refresh）。
- 37 万文件的工作区里连续输入 10 个字符 → Host 进程 CPU 无持续尖峰。
