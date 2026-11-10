# 会话尾窗与最后一轮的 turnHeader

## 现象

会话仍在运行（`control.phase === "running"`、输入框显示排队、底部统计在跳），
但最后一轮下方的运行行「⟳ 用时 X · 调用 N 次工具」整行消失。

## 根因

下发快照只带最后 `snapshotTailWindowRows`（60）行（`conversation-topic-publisher.ts`）。
`turnHeader` 落在每一轮的**起点**，长轮次必然被切到窗口外。UI 判断「本轮是否在跑」
读的是 header：

- 有 header → `resolveTurnRunning` 只看 `header.state === "running"`
  （`packages/ui/src/v4/conversationTurnRenderUnits.ts`）。
- 无 header → 退化成「窗口里有没有仍会阻塞完成的运行行」
  （`isCompletionBlockingWorkRowRunning`）。它排除 `backgrounded` 行；模型正在思考、
  或后台子代理刚回结果时，窗口里剩下的工具行全部已落定。

于是 `shouldShowTurnChatLoading` 的 `isRunning` 为假，整行不渲染
（`packages/ui/src/v4/chatLoadingVisibility.ts`）。

实测（真实会话 `sess_6919a824…`「Response格式思考等级解析排查」重放）：

| 重放方式  | running 采样 | 丢运行行    |
| --------- | ------------ | ----------- |
| 完整窗口  | 3829         | 0           |
| 60 行尾窗 | 3829         | 1156（30%） |

1156 次全部是「header 不在窗口内」。近 25 个真实会话 46 个轮次的窗口行数中位数 33、
p90 247、最大 518；UI 自动补拉上限 `LEADING_TURN_AUTOLOAD_PAGES = 3`（180 行），
**17.4% 的轮次超过该上限**，补拉救不回来。

## 决定

两处都改，职责分开，不互相兜底成第二条事实源。

### 1. 下发侧：最后一轮的 header 与首条可见输入保底进窗口

所有者仍是 `ConversationTopicPublisher.getWireSnapshotForProfile`。窗口规则从
「最后 60 行」改为「最后 60 行，外加最后一轮的行首锚点」：

- 保底对象：**最后一个 product turn 的 `turnHeader`**，以及该轮第一条
  `userInput`（若其在窗口外）。
- 保底只向上补到这两个锚点，不从窗口首行继续往前扩；更早历史仍走 `rows/range`。
- 保底后窗口行数上限不变式：`window.length <= snapshotTailWindowRows + 2`。
  这是有限增量（header 与 userInput 各一行），不影响 `projectionLimitForEvent`
  的字节预算判断的量级。
- `rows.firstRowId` 仍是全序首行，`hasOlderRows` 语义不变：保底行 rowId 更小，
  客户端因此知道还能往上翻。

理由：`turnHeader` 是轮次的权威边界，不是可裁的展示细节。客户端不该为了判断
「在跑」去发一次 `rows/range`。

### 2. 客户端：header 缺失时允许会话相位证明最后一轮在跑

所有者仍是 `shouldShowTurnChatLoading`。新增一条**窄**兜底：

- 仅当最后一个 render unit **没有 header** 时，才接受 `sessionPhase === "running"`
  作为 `isRunning` 的依据。
- 有 header 时行为完全不变：header.state 是权威，陈旧 running 历史轮不会被相位重新
  点亮（`conversationTimelineLiveDuration.ts` 与 `ConversationTimeline.tsx` 的
  `liveUnitTickable` 语义保持）。
- 兜底同时要求 `isLastTurn`：中间轮次缺 header 不是「在跑」，只是冷快照截断。

补充口径（同一次改动内定稿，避免二次返工）：

- 缺 header 的最后一轮，`workStatus.durationMs` 算不出（没有 `startedAt`）。
  运行行因此只报次数（`chat.history.foldedTools`），不写「用时 0 秒」。
  这比编一个假工时要诚实。
- 缺 header 时 `executionKind` 未知，按 `agent` 处理（`controlOnly` 轮次不产生
  运行行，但这类轮次也不会是长轮次被截断的对象）。

## 不做什么

- 不把 `snapshotTailWindowRows` 从 60 调大：那是所有会话的常驻 wire 成本，
  且不能根治（更长的轮次依然会被切）。
- 不改 `control.phase` 语义，不因缺 header 就回写 phase 或伪造 header 行。
- 不让客户端拿 `control.phase` 覆盖**存在**的 header.state：计划审查、后台子代理
  收口时两者本来就会短暂分叉（`projector.ts` 的 `holdPlanReview`）。

## 验收场景

1. 60 行尾窗，最后一轮 header 被切掉、窗口内工具行全部已落定 → 运行行照常出现，
   文案为「调用 N 次工具」。
2. 同上，但 `sessionPhase` 是 `completedSuccess` → 不出现运行行。
3. header 在窗口内且 `state: "running"` → 与今天一致（含「用时 X · 调用 N 次工具」）。
4. header 在窗口内且 `state: "completedSuccess"`，但 phase 仍是 running → **不**出现
   运行行（不回归计划审查/后台子代理的既有分叉语义）。
5. 非最后一轮缺 header → 不因相位点亮。
6. 下发快照：最后一轮长于 60 行 → 窗口含该轮 `turnHeader` 与首条 `userInput`，
   `window.length <= 62`，`rows.firstRowId` 仍指向全序首行。
7. 下发快照：最后一轮行数不足 60 → 窗口仍恰好是最后 60 行（保底不缩小窗口）。
