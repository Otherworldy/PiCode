# 待办步骤的统一状态图形与文本

## 背景

待办（plan）在三个界面各渲染一遍，三份实现互不相干：

| 界面                     | 文件                                                                    | 状态形式                                                  |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 右侧状态面板「进程」区块 | `packages/ui/src/v4/ConversationStatusPanel.tsx`（`PlanStatusIcon`）    | `ArrowRightIcon` / `CircleIcon` / `CircleCheckIcon`，14px |
| 会话内 todo 工具卡       | `packages/ui/src/ToolCallBlocks/renderers/todo.tsx`（`TodoStatusIcon`） | 同上，14px                                                |
| 输入框待办抽屉           | `packages/ui/src/v4/ComposerTodoDrawer.tsx`（`TodoStatusIcon`）         | 同上，16px                                                |

三个问题：

1. **图标语义不一致**。同一件事（「这一步在跑」）在状态面板用一个静态右箭头表达，
   和会话里到处出现的圆形 spinner 抢语义；14px 空环（`lucide` 的 `CircleIcon`）线条偏细
   偏灰，和旁边实心勾的视觉重量差太多，整列看不出「同一列的三种状态」。
2. **模型侧文本原样落到界面**。模型习惯把整行写成 `**Step 1: 后端路由…**`，
   于是用户看到字面量 `**`；列表行本身已经有字号/颜色层级，强调符号是噪声。
3. **头部计数只有 `2/5`**。分不出「还剩几个没开始」和「有几个在跑」，
   中文标签还叫「进程」（process），和 progress 不是一个意思。

参考 `deepseek-harness`（dsh）的 `StateDot`：完成=实心勾圆点、进行中=细环+呼吸弧、
待办=细空心环；头部用按状态分段的计数文案。

## 状态所有者

| 职责                                  | 所有者                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| 单个步骤在某状态下的图形与文字样式    | `packages/ui/src/components/TodoStepGlyph.tsx`（唯一实现）                                   |
| 步骤文本里的强调符号清洗              | 同上，`stripTodoStepEmphasis`                                                                |
| 分段计数的文案与拼接                  | `packages/ui/src/v4/ConversationStatusPanel.tsx`（`PlanStatusSection`），i18n key 在 locales |
| 步骤数据（`items` / `status` / 顺序） | 不变，仍由 `conversationStatusPanelModel.ts` 从快照投影                                      |

本 spec 只改展示层，**不动**协议、投影、`PlanState` 结构、todo 工具输出解析。
不新增状态，不改变步骤顺序。

## 规则

1. **一个图形组件，三个消费者。** 状态面板、工具卡、抽屉都渲染
   `TodoStepGlyph`，不再各自写一份 `if (completed) … if (inProgress) …`。
   收起态摘要胶囊的图标槽也用同一个组件（`size-4` 覆盖）。
   输入框待办抽屉收起时，头部在展开箭头后面显示**当前步骤**的状态点，
   位置和展开后的每一行一致；它跟随 `ComposerTodoModel.activeStatus`，
   不是固定图形。
   文本清洗另有两处调用：探索子行（`explore.tsx`）和摘要胶囊。
2. **两种拼写是同一个状态。** `ZCodePlanStep` 用 `in_progress`，V4 快照 `PlanItem` 用
   `inProgress`；组件同时接受两种，展示层不要求调用方转写。
3. **尺寸固定 14px（`size-3.5`）**，三种形状外径都是 14px。它随 14px 正文
   （`text-ui-base`）走，排在行首形成一条竖线；不使用 `size-4` 造成行内图标比文字更抢眼。
   进行中的 SVG 用 `viewBox="0 0 14 14"`、`2r + strokeWidth = 14`，
   和待办的 14px `border-box` 空心环完全重合，不能出现「进行中比待办小一圈」。
   唯一例外是收起态摘要胶囊的 16px 图标槽，通过 `className` 覆盖。
4. **颜色只用语义 token**：完成 `--color-success` + `--color-success-foreground`；
   进行中整环用正文色（`--color-foreground`，轨道降到 0.2 不透明度）；
   待办用 `--color-foreground-subtle` 的 1.5px 边框。
   进行中必须比待办更重 —— 轨道若和待办同亮度，正在跑的那一步会显得比排队的还淡。
   完成项文字继续走 `--color-foreground-subtlest` + 删除线。
5. **进行中的弧线动画必须能被 `prefers-reduced-motion` 关掉**，
   关闭后停在一个静态弧上，不能退化成空环（空环＝待办，语义会串）。
6. **清洗只做行内强调**：去掉成对的 `**…**` 和 `__…__`。
   不解析标题、列表、代码块，不删单个 `*` / `_`（会和 `*.ts`、`snake_case` 撞）。
   两条防误伤约束：
   - 加粗对里面不允许再出现 `*`。否则 glob 里的双星会先被配对，
     `改 src/**/*.ts 和 **路由**` 会被吃成 `改 src/*.ts 和 路由**`。
   - 下划线对内容不能是纯 ASCII 标识符，否则 `__init__` / `__main__` 会被剥掉；
     但必须允许中文（`__注意__`）——中文没有空格，不能用「含空格」当判据。
     清洗是纯展示，不写回快照、不写回工具输出。
7. **状态不能只靠颜色**。图形带 `role="img"` + `aria-label`（已完成 / 进行中 / 未开始），
   读屏用户才能区分三种状态；行内文字只承载标题。
8. **头部计数按状态分段**：「已完成 N · 进行中 N · 待处理 N」，数量为 0 的分段不渲染；
   三个都为 0（空计划）时该区块本身不渲染。中文标题从「进程」改为「待办」，
   英文保持 `Progress`。

## 接口

```tsx
// packages/ui/src/components/TodoStepGlyph.tsx
/** ZCodePlanStep 用 in_progress，V4 快照 PlanItem 用 inProgress。 */
export type TodoStepStatus = "pending" | "in_progress" | "inProgress" | "completed";

/** 状态图形；自带 role="img" + aria-label，读屏可读状态。 */
export function TodoStepGlyph({
  status,
  className,
}: {
  status: TodoStepStatus;
  className?: string;
}): ReactNode;

/** 与状态匹配的文字样式（颜色 / 删除线）。 */
export function todoStepTextClass(status: TodoStepStatus): string;

/** 去掉行内成对强调符号并 trim。 */
export function stripTodoStepEmphasis(text: string): string;
```

```ts
// packages/ui/src/v4/messageStreamTodoModel.ts
interface ComposerTodoModel {
  steps: ZCodePlanStep[];
  completedCount: number;
  activeTitle: string;
  /** 抽屉头部状态点跟随的那一步；没有活动步骤时回落 pending。 */
  activeStatus: ZCodePlanStep["status"];
}
```

```ts
// 新增 i18n key（en-US / zh-CN 同步）
"chat.statusPanel.todoCountDone": "已完成 {count}" | "{count} done"
"chat.statusPanel.todoCountActive": "进行中 {count}" | "{count} running"
"chat.statusPanel.todoCountPending": "待处理 {count}" | "{count} waiting"
```

## 验收场景

1. **状态渲染**：`completed` 渲染实心绿底白勾，`pending` 渲染空心环，
   `in_progress` 与 `inProgress` 渲染同一个旋转环（同一份 DOM，仅状态拼写不同）。
2. **文字样式**：完成项带删除线且用 tertiary 色；进行中用于正文色；待办用 secondary 色。
3. **强调符号**：`**Step 1: 改造**` 显示为 `Step 1: 改造`，`__注意__` 显示为 `注意`；
   `path/to/*.ts`、`snake_case_name`、`__init__` 原样保留；
   `改 src/**/*.ts 和 **路由**` 只清掉后面的强调，glob 不动。
4. **分段计数**：5 项里 2 完成、1 进行中、2 待办时，状态面板头部显示
   「已完成 2 · 进行中 1 · 待处理 2」，且不出现 `2/5`。
   （分组行本身在面板变体下不渲染，所以这条断言只能守住区块头部。）
5. **零分段隐藏**：只有 2 项待办、无完成无进行中时，头部只显示「待处理 2」。
6. **三面一致**：同一份 `plan` 分别喂给状态面板、todo 工具卡、输入框抽屉，
   三项的状态图形 DOM 结构相同（尺寸、颜色类、SVG 路径一致）。
7. **减少动效**：`prefers-reduced-motion: reduce` 下进行中态不旋转，
   但仍有一道可见弧（不是空环）。
8. **视觉重量**：进行中的弧比待办的空心环更重（更深的色）且外径相同，
   批量排列时能一眼看出哪一步在跑，又不至于大小参差。
9. **读屏**：三种图形分别暴露「已完成 / 进行中 / 未开始」，不只靠颜色和删除线。
10. **抽屉头部**：收起状态下头部渲染 `activeStatus` 对应的图形，
    当前步骤是「进行中」时头部就是旋转环，不是固定图标。

## 未覆盖

- **不改模型提示词**：仍可能写出别的 markdown 记号（`###`、`- `、反引号），
  本 spec 只处理行内强调。
- **不做同屏动画相位对齐**：dsh 把 spinner 的 `animation.startTime` 钉到 document 时间零点，
  这里不引入 JS 动画控制；同一屏出现两个进行中步骤时进度弧相位可能不同步。
- **不改 `todos/todoBoard.tsx`**：那是任务看板（`TodoStatus` 六态、按列分组），
  和会话里的 plan 步骤不是同一套数据。
- **不改折叠预览里的分组文案**（`todoCompletedFold` / `todoWaitingFold` 等），
  它们描述的是「被折叠掉多少条」，不是进度。
- **不改另外三处的分数进度**：会话内 todo 工具卡头部、输入框待办抽屉、探索子行仍显示
  `2/5`。它们是一行高的紧凑位，塞不下三段计数；本 spec 只统一图形与文本，
  不改这三处的计数形态。
