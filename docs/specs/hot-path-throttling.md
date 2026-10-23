# 热路径节流：滚动、布局轮询与 UI 时钟

## 背景

渲染层有一类反复出现的缺陷：**强制布局读没有 rAF 合并**，以及**UI 时钟进了 render model
的依赖**。它们单个看起来很小（一次 `getBoundingClientRect` 而已），但触发频率是
scroll 事件（60–120 Hz）或流式帧（33 Hz），乘上会话里的元素数量就是持续的掉帧与 GC 抖动。

三个具体例子（本 spec 的验收对象）：

1. `markdown-table.tsx` 的 `viewport.addEventListener("scroll", updateEdgeShadowState)` ——
   同一文件里已经写好了 `debouncedUpdate`（rAF 合并），但它只挂在 `window.resize` 上，
   scroll 走的是裸函数。每次 scroll 事件做 2 次布局读 + setState。
2. `markdown-table.tsx` 的 `scheduleMeasureAndWatchRect` —— 每次调用把 `rectWatchUntil`
   续到 `now + 800ms`，而它是 `ResizeObserver` 的回调。流式期间表格内容每帧长高 →
   ResizeObserver 每帧触发 → 轮询循环**永不退出**，每帧 2 次 `getBoundingClientRect`。
3. `ConversationTimeline.tsx` 的 `liveNowMs` —— 1 Hz 的 `setInterval` 只为显示
   "工作中 N 秒"，但它进了 `buildConversationTurnRenderUnits` 的 deps，导致**每秒对
   整个 `rows` 全量重建** render units。

另外两条同类的无节流观察者：

4. `components/ui/toast.tsx:203-210` —— `MutationObserver` 观察 `document.body`
   `{childList, subtree}`，回调里 `getElementById` + `getBoundingClientRect` + `setLeft`
   （setState）；同时 `document.addEventListener("scroll", syncPosition, {capture:true})`。
   只要存在一个 anchored toast，流式期间每个 DOM 变更都触发一次强制布局 + setState。
5. `components/ui/code-viewer.tsx:590-596` —— rAF 已合并，但 `patch()` 每次对整棵 DOM +
   所有 shadow root 做全量 `querySelectorAll` 给 gutter 按钮补 label。流式代码块内容每帧变
   → 每帧 O(行数) DOM 查询。

## 规则

1. **DOM 布局读必须 rAF 合并。** 任何由 scroll / wheel / MutationObserver / ResizeObserver
   触发的回调，只要里面有 `getBoundingClientRect` / `offsetHeight` / `scrollHeight` /
   `getComputedStyle` / `scrollLeft` 读取，就必须通过一个 `requestAnimationFrame` 合并点。
   同一帧内多次触发只做一次。
2. **轮询必须有终止条件，且续期要有理由。** 一个 `requestAnimationFrame` 自递归的循环，
   只有在「观察到目标契约的不变量仍然成立」时才续期。如果续期条件是"每次 observer 回调"，
   那么任何持续变化的内容都会让循环变成常驻。续期前先比较本次测量结果与上次是否不同。
3. **UI 时钟不能进 render model。** 「现在几点」是渲染层关注点，不是 projection 的输入。
   需要按时间推进的文案（时长、倒计时）用叶子组件自己订阅时钟，不要把它抬到
   `build*Units` / `select*` 这类全量计算的入参里。
4. **同文件已有正确的节流工具时，优先复用。** 不要在同一段代码里同时存在"裸函数"和
   "rAF 版本"两条路径 —— 后来的人只会看到其中一条。

## 本轮的取舍

`liveNowMs` 的正确修法是把「运行中段的起止时间戳」留在 render unit 里，由叶子组件算时长。
但那会改动 `conversationTurnWorkSegments` 的输出契约，和已知的架构级问题（每 chunk 全量
重建 render units）是同一处。**本条与架构级优化合并处理，本轮不动**，只在 spec 记录规则 3，
避免下一个改这块的人再把它当低成本修法加进 deps。

## 验收场景

- 会话里有一张 30 行表格时，滚动整条时间线：`Performance` 面板中该元素每次 scroll
  只产生一次布局读（不是两次）。
- 流式回答里含表格，持续 60 秒不再有内容变化：表格的 rAF 轮询在 800ms 后停止
  （用 `requestAnimationFrame` 计数器验证）。
- 长会话（3000 行）有 run 在跑：1 Hz 的时钟不再触发 `buildConversationTurnRenderUnits`。
- 存在一个 anchored toast 时，流式回答期间 `Performance` 面板里 `syncPosition` 的调用次数
  与 DOM 变更次数不成正比（每帧最多一次）。
- 1000 行的代码块流式更新时，`patchCodeCommentUtilityButtons` 只处理新增节点，
  不再每帧全量扫描。
