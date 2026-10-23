# 渲染与启动热路径预算（第五轮）

## 背景

第五轮审计从「渲染期对象身份」与「冷启动链路」两个新角度扫出的 13 条问题。本 spec 记录
**已修的 9 条**的约束，以及**未修的 4 条**为什么留待后续。

核心判据：渲染期每帧/每 delta 的浪费分两类 —— 一是**代码读了刚写脏的布局**（强制同步 reflow），
二是**引用身份不稳定导致订阅/测量/跨进程调用重跑**。

## 已修（9 条）与对应规则

### 渲染期

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `packages/ui/src/components/ui/scroll-fade-viewport.tsx` | effect 依赖 `children`，而调用方每传一次都是新 JSX → 每个流式 delta 重建 ResizeObserver + 一次同步强制布局 | 依赖改成 `[]`；尺寸变化由已有 `ResizeObserver.observe(content)` 覆盖 |
| `ToolCallBlocks/renderers/ExecuteOutput.tsx` | 写 `scrollTop` 后回读它 → 每 delta 两次强制 reflow | 一次读出 `scrollHeight - clientHeight` 算上限，写回不再回读 |
| `components/ai-elements/reasoning.tsx` | `resolveVerticalScrollMaskState` 在有溢出时返回新对象 → 60–120Hz 的 scroll 事件每次都重渲染整棵思考子树 | `setState` 用值比较，相等则复用旧对象 |
| `ToolCallBlocks/renderers/cua-group.tsx` | `onScroll` 裸 handler 读 3 个几何属性；mask state 同上 | rAF 合并（每帧最多一次）+ 值比较复用 |
| `components/ai-elements/mermaid-block.tsx`（渲染） | effect 依赖 `trimmedCode`，每个 delta 都跑一遍 mermaid 布局 + `dangerouslySetInnerHTML` 销毁重建整段 SVG | 250ms settle 后再渲染（loading 态仍立即显示） |
| `WorkspaceGroupedTasksSection.tsx` | 每帧对每个分组做 `querySelector` + `CSS.escape` | header 映射在 effect 里建一次（与 `view.nodes` 同寿命），滚动时只查 Map |
| `ToolCallBlocks/renderers/cuaListDetails.tsx` | effect 依赖 `items` 数组引用，流式中 `toolCall` 换身份就重新 invoke 全部 app 图标（响应是完整 base64 PNG） | 依赖改成「排序后的 bundleId 集合」签名 |

### 启动期

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `components/ai-elements/mermaid-block.tsx`（模块顶层） | import 即创建 span + `willReadFrequently` 的 2D canvas（强制 CPU 光栅，部分驱动下 `getContext` 是 10–100ms 级同步调用），而 `renderMermaid` 默认关闭 | 惰性化：首次真正归一化颜色时才创建 |
| `packages/desktop/src/main/forceUpdateGuard.ts` | 强更检查串行阻塞首窗创建，超时 10s → 离线/弱网白屏最多 10s | fail-open 得更快：超时降到 3s（无法确认时按放行处理） |

## 规则（新增代码必须遵守）

1. **写完布局属性不要再读同一个属性。** 需要「写入后的实际值」时，用同一批读取算出来
   （如 `scrollHeight - clientHeight`），不要回读被写脏的属性。
2. **订阅/测量的 effect 依赖里不能放每渲染新建的值**（JSX、对象字面量、内联箭头）。
   依赖不稳定时，用「原始值签名」（排序后的 id 串、布尔）代替引用。
3. **高频事件（scroll / pointermove / resize）必须 rAF 合并**，且 cleanup 里
   `cancelAnimationFrame`。
4. **`setState` 的目标值来自「每次新建的对象」时，先做值比较。** 尤其状态对象只有两三个
   布尔字段时，引用比较会让每次事件都触发整棵子树重渲染。
5. **模块顶层不做 DOM/GPU 副作用。** 首屏链上被静态 import 的模块，顶层只允许常量与纯函数；
   需要 DOM 的资源改成惰性初始化。
6. **阻塞首窗创建的每个 await 都要问「无法确认时能不能放行」。** 外部网络依赖应当 fail-open
   且超时要短（本仓取 3s），不能把冷启动时间押在远端可用性上。

## 未修（4 条，已分析）

### 1. `editors` 的 5 个挂载点各持一份 base64 图标数组

`packages/desktop/src/main/editors.ts` 的 `inFlightEditors` 只去重**探测**工作；5 个互不相关的
挂载点（`message.tsx`、`OpenSplitButton.tsx`、`PreviewPane.tsx`、`useInstalledFileTreeEditors.ts`、
`WorkspaceEditorButtonGroup.tsx`）首屏同时 `invoke`，每个 renderer 调用都独立 structured clone
一遍 `iconDataUrl` 数组，且各自 `useState` 长期持有副本。

**为什么不改**：正确修法是把「已安装编辑器列表」提升成一个共享 store / context（`packages/ui`
的 Zustand store 层），而不是各处自己 `useState`。这动 5 个组件的数据来源，需要回归
「编辑器缺失时按钮隐藏」等多条既有行为，超出性能修复的范围。

### 2. 首屏包 8.4 MiB / 271 条 modulepreload，无代码分割

构建产物实测（`packages/desktop/out/renderer`）：主 chunk `styles-*.js` 5.3 MiB / 2004 模块，
含 mermaid、两份 shiki、`@pierre/diffs`、framer-motion、qrcode、`@lexical/react`。
`schema-v1` 层面没有任何 `lazy(`：`packages/ui/src/Root.tsx` → `ConversationRowView` →
`ai-elements/message` → `code-block` 是静态链。

**为什么不改**：需要把 `code-block` 的 `MermaidBlock` / `CodeViewer` 改成 `React.lazy` + Suspense，
并在 `vite.config.ts` 加 `manualChunks`。这是渲染路径的结构性改动（要设计 fallback 高度、
避免布局跳动、验证流式期间不会重复挂载），必须配 E2E，不适合与其它性能修复混在一批。

### 3. 两份 locale 字典 785 KB 静态进首屏

`packages/ui/src/i18n/IntlProvider.tsx` 同时静态 import `zh-CN`（425,987 B）与 `en-US`（422,802 B），
产物 `IntlProvider-*.js` = 785,360 B 且被 modulepreload。产品只支持 2 个 locale，等于 50% 字节纯浪费。

**为什么不改**：改成按需 `import()` 会让 `formatMessage` 变异步，首屏多一次 waterfall 并可能闪烁
（未加载完时显示 key 或英文）。可行方向是「静态加载当前 locale + 首屏后 idle 预取另一个」，
但需要先决定「切换语言时的加载态」这个产品行为。

### 4. 装了两份 shiki（3.23.0 与 4.0.2），两份都进产物

`node_modules/shiki` 与 `packages/ui/node_modules/shiki` 各一份大版本，sourcemap 里同时含
`shiki/dist/langs.mjs`、`themes.mjs`、`engine-oniguruma` 与 `langs-bundle-full-*.mjs`。

**为什么不改**：这是依赖树问题（某个包锁了旧版本），对齐大版本需要先确认 4.x 的 API 兼容性并
跑一遍高亮回归；`shikiHighlighter.ts:12-17` 为了做「语言名是否存在」的判断而静态引入
`bundledLanguages`，也应改成 `import()` 或换成本地白名单。

## 验收场景

- 流式输出期间（Bash 工具持续 chunk）的 DevTools Performance 剖面里，`Layout` 次数不再随
  delta 数线性增长；`scroll-fade-viewport` 的 ResizeObserver 创建次数恒为 1。
- 思考块内滚动的 `Paint` 次数与 scroll 事件次数解耦（值未变时不重渲染）。
- 含 mermaid 代码块的消息流式输出时，mermaid 布局计算次数 ≈ ceil(时长 / 250ms)，而不是 chunk 数。
- 侧栏 50 个分组滚动时，每帧的 `querySelector` 调用为 0。
- 首次渲染一个不含 mermaid 的会话时，不再创建 2D canvas（`willReadFrequently` 后端）。
- 弱网/离线冷启动：从 `app.ready` 到首窗可见的时间不再含 10s 量级的等待。
