# To-Dos

To-Dos 是项目上的工作队列，不是侧栏会话。一条 To-Do 必填标题、说明和所属项目。归属键是 `workspaceIdentity?.trim() || workspacePath`，创建后不改。项目必须是 Git 仓库根，不能是已有 worktree，也不能是仓库子目录。

## 所有者

| 状态 | 所有者 |
| --- | --- |
| 行（状态、项目、分支、worktree、sessionId） | `TodoRepo`（`tasks-index.sqlite` 表 `todos`） |
| worktree / 合并结果 | 该项目所在 Host 的 Git |
| 会话 | 现有 V4 `createSession`，`workingDirectory` 指向 worktree，会话仍挂在该项目 |

桌面 Main 不保存这些行。手机远控看同一条 Host。

## 状态

`todo → running → needs_review → done`。旁路 `failed`、`canceled`。`done` 只从 `needs_review` 写入。`settle` 只把 `running` 推进到 `needs_review` 或 `failed`；没有行、或行已不是 `running`，则不动。

同一项目可以同时有多条 `running`。每条用自己的分支和 worktree，不互相占用。同一行不能占两次。

## 开始

1. 占上 `running`。失败则整行改为 `failed` 并写下原因。
2. 新建行的 `id` 是 `todo-1`、`todo-2`……全局递增，删除不复用（分支可能还在）。分支和目录都用这个名字：`todo-1`、`<repo>/.worktrees/todo-1`。旧的 uuid 行仍用 `todo/<id>` 和 `.worktrees/todo-<id>`。起点是当时 HEAD。
3. `createSession`，会话权限为完全访问（`yolo`），执行目录是该 worktree。这个目录要写进 sessions-index 的 `workingDirectory`。列表用它标分支，过长就截断，不换行盖住下一行。右上角 Git 卡片的状态、切分支和提交都查这个目录；查主工作区的话，一点开当前分支就会变成 main。缺了就都停在主工作区。首条输入是说明加固定限制：可以在 To-Do 分支上提交，禁止合并、变基、推送基线分支。
4. 记下 `sessionId`。`failed` 且已有会话时，开始只在同一会话再发一轮，权限仍是完全访问。

进程启动时残留 `running` 改为 `failed`（中断），工作树保留。

## 审阅与合并

审阅打开已有会话，diff 用现有 Git 面板。合并由 `mergeBranch` 执行：主工作区必须在记录的基线分支上且干净；有提交才合并；冲突则停在 `needs_review` 并写原因，不自动解。相对基线没有提交时只能 `complete`，不能合并。

放弃写成 `canceled`。删除 worktree 是可选项，默认不删。`restore` 只把 `canceled` 改回 `todo`，不新建工作树。

## 验收

- 不带项目不能创建。两个项目的列表不串。
- 同一项目第二条 start 在已有 `running` 时仍开始。同一行再 start 拒绝。
- `settle` 对未知 session 无操作。
- 无提交不能 merge，只能 complete。
