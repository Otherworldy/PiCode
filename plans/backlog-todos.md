# 待办队列（Backlog）

## Context

侧栏 Task 是一条 Agent 会话（`taskId` = `sessionId`），人坐在旁边聊，跑在当前工作区。要加的是另一条产品：写下标题和说明，并指定所属项目，手动开始，在该项目的隔离 worktree 里跑完，人看 diff 后合并或放弃。参考 Codeg 的 To-dos，但不做它的后半段（定时、自动开跑、自动合并、Agent 代合并、Issue/PR、模板、init/preflight）。

完成只写两处：Git 确认合并进基线，或「相对基线无提交、直接完成」。失败和取消不写成完成。

## Approach

新域叫 To-Dos，不叫 task，不叫 backlog，不往 `ZCodeTaskMeta` / `off_peak_tasks` 加字段。

一条 To-Do：`id`、`title`、`prompt`、所属项目（`workspacePath` + `workspaceIdentity`，必填）、`baseBranch`、`baseCommit`、`branchName`、`worktreePath`、`sessionId`、`status`、`error`、时间戳。项目只能是项目根，不能是已有 worktree。归属键是 `workspaceIdentity?.trim() || workspacePath`，创建后不改。列表和筛选都按这个键区分项目，不能因当前打开的工作区隐含归属。

状态：`todo → running → needs_review → done`，旁路 `failed`、`canceled`。不设排队、初始化、合并中。同一项目可以同时跑多条，每条在自己的 worktree 里。开始时会话权限默认完全访问。

开始时：

1. 目标必须是所选项目的 Git 根。不是就拒绝。不随当前焦点工作区改挂。
2. `IGitService.createWorktree`，分支 `todo/<id>`，目录 `<repo>/.worktrees/todo-<id>`，`startPoint` 为该项目当时 HEAD。现有规则要求副本在 `.worktrees/` 下，不能学 Codeg 放在仓库旁边。
3. 用现有 `createSession`，会话挂在所选项目上，不新开左侧项目；`workingDirectory` 指向该 worktree。首条输入是用户说明，末尾加固定句：可以在 To-Do 分支上提交，禁止合并、变基、推送基线分支。
4. 行上记下 `sessionId`。

会话结束：在现有 `turn.completed` / `turn.failed` 收口处调一次 `todos.settle(sessionId)`。没有对应行就返回。`turn.failed` → `failed`；`turn.completed` → `needs_review`。不新开事件总线，UI 关掉也能落状态。进程重启时若仍是 `running`，标 `failed`（中断），工作树保留，重试在同一会话再发一轮。

审阅用现有 Git diff，对比该项目的 `baseCommit...worktree`。合并不让 Agent 做：该项目主工作区必须在 `baseBranch` 上且无暂存/未提交；To-Do 分支有提交则 `git merge` 进该项目主工作区（新增一个 Git 方法，现有接口只有 commit 没有 merge）。有冲突则停在 `needs_review` 并写下原因，不自动解。工作区有未提交改动则拒绝合并，让用户先在该会话里提交。相对基线没有提交时只提供「完成」，不制造空合并。

放弃：`canceled`。可选删除 worktree（已有 `removeWorktree`）。默认留着。

界面：侧栏入口叫 To-Dos，主区域一个列表（无看板、无拖拽）。新建必填标题、说明、项目；项目从已有工作区里选，默认当前项目，但必须显式选中。每行显示所属项目，列表可按项目筛选。行操作：开始、打开会话、看 diff、合并、无改动则完成、放弃、删除。打开会话切到该项目，不是当前焦点项目。远端项目走那台 Host 上的 Git 和会话，不在桌面 Main 里记状态，不为手机另起引擎。

## Files to modify

- `packages/services/src/todos/SPEC.md` — 先写规则、状态所有者和验收场景。项目归属写进规则。
- `packages/shared` — To-Dos 类型、`ServiceChannels.Todo`。
- `packages/services/src/todos/` — repo（`tasks-index.sqlite` 新表 `todos`）+ `ITodoService`。注册照 `OffPeakTask`。
- `packages/services/src/git/` — `mergeBranch`（工作区干净、在基线分支、合并指定分支）。补 `SPEC.md` 一条。
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` — 终态处调用 `settle`，无行则空操作。
- `packages/ui` — 侧栏入口、列表、`offPeakTaskStore` 同款的 RPC store。打开会话走现有选中 task。
- 协议面只复用已有 `createSession.workingDirectory`，不改 V4 命令形状。

## Reuse

- `IGitService.createWorktree` / `removeWorktree` / `getDiff` — `packages/services/src/git/git.ts`。副本必须落在 `<repo>/.worktrees/`，见 `packages/services/src/git/SPEC.md`。
- `createSession.workingDirectory` — `packages/shared/src/zcode-protocol-v4/command.ts`。会话留在父仓库。
- 草稿绑定同一语义 — `packages/ui/src/v4/sessionWorktree.ts` 的 `isWorkspaceWorktree`。
- 表和通道写法 — `packages/services/src/session/offPeakTaskRepo.ts`、`ServiceChannels.OffPeakTask`。只抄结构，不复用闲时状态机。
- 终态收口 — `zcodeTaskIndexSyncer.ts` 里 `turn.completed` / `turn.failed`。
- 开会话 — `IZCodeTaskService.createTask` / V4 `createSession`（带 `workingDirectory` 和首条输入）。

## Steps

- [x] 写 `packages/services/src/todos/SPEC.md`（状态、谁写入、项目归属、Git 验收、远端身份）。
- [x] shared 类型 + channel。sqlite 表 `todos` 与 repo：创建（必带项目）、按项目列表、开始占用、settle、合并、完成、放弃。
- [x] `ITodoService`：start 内顺序为建 worktree → 开会话；失败则行进入 `failed` 并留下原因。同一项目不互斥。
- [x] Git `mergeBranch`：干净工作区、在基线、合并、冲突则原样返回。
- [x] syncer 终态调用 `settle`。启动时把残留 `running` 打成 `failed`。
- [x] UI 列表接到该服务。diff 用现有 Git 面板数据，不新做 diff 组件。
- [x] 架构检查后跑 typecheck、lint，加下面的测试。

## Verification

- 服务测试：状态只允许图上的边；不带项目不能创建；两个项目的行不串；`settle` 对未知 `sessionId` 无操作；同一项目可以同时占多条 `running`，同一行不能占两次；无提交不能 merge，只能 complete。
- 现有 worktree 测试仍绿。手动：`pnpm dev:desktop`，新建时选一个脏工作区作为项目并开始，列表上看得到该项目。主目录 HEAD 不动，会话出现在所选项目而不是新项目，Agent cwd 在 `.worktrees/todo-*`。结束后行变为待审。主工作区脏时合并被拒；干净且在基线分支时合并成功并标完成。放弃不改主工作区。

## 不做

定时、自动开跑、自动合并、每阶段提示词、init/preflight、看板、模板、从消息或 PR 生成、Agent 专用工具、压缩上下文。要这些时再加状态，不另开产品。
