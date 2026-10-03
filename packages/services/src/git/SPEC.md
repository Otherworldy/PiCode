# Git Service & Worktree

Git 服务提供基于本地 Git CLI 的仓库状态读取与分支/变动操作。本模块是 Git 相关能力的唯一服务实现。

## 所有权与生命周期

| 状态 | 所有者 | 派生 |
|---|---|---|
| Git 仓库状态（分支、HEAD、dirty、staged） | 本地 Git 仓库（`.git`） | `GitRepositorySummary`、`GitFileChange[]` |
| Git Worktree（关联工作树） | Git `git worktree`（`<repoRoot>/.git/worktrees/`） | `GitWorktreeInfo[]` |
| Worktree 默认存储位置 | `<repoRoot>/.worktrees/<sanitizedBranchName>` | 根目录 `.gitignore` 忽略 `.worktrees/` |

## Worktree 规则

1. **会话与分支隔离**：
   - 普通 `switchBranch` / `createBranchAndSwitch` 在当前 `workspacePath` 磁盘目录直接切换 HEAD，影响该目录下的所有会话。
   - 还没有提交的分支只写在 worktree 的 HEAD 上，`git switch` 会报 `invalid reference`。这种分支已经在某个 worktree 里，切换应进入那个目录，不能报“分支不存在”。
   - `createWorktree` 通过 `git worktree add` 创建独立磁盘目录副本，拥有独立的 HEAD 与文件状态。
   - 具有未提交更改（dirty）的主工作区不受影响，可以安全并行开出新分支的 Worktree。
2. **分支存在性处理**：
   - 若目标分支已存在：执行 `git worktree add <worktreePath> <branchName>` 检出已有分支。
   - 若目标分支不存在：执行 `git worktree add <worktreePath> -b <branchName> [startPoint]` 创建并检出。
3. **路径安全**：
   - 目标路径若未显式指定，规范化到 `<repoRoot>/.worktrees/<sanitizedBranchName>`。
   - 净化分支名称中的非法路径字符（如 `/` 转为 `-` 或合法相对路径段）。

## 验收场景

1. **有未提交更改时创建独立分支**：主仓库有 2 个未提交修改，调用 `createWorktree` 创建新分支成功，主仓库状态保持未提交，新 Worktree 目录干净且处于新分支。
2. **分支已存在时挂载 Worktree**：目标分支已在本地或远端存在，正确以现有分支检出到新 Worktree。
3. **UI 创建并检出新分支**：勾选“在独立工作区 (Worktree) 中打开”后，调用 `createWorktree`。新会话仍挂在当前项目下，不新增左侧项目。Agent cwd 与该会话的 Git 状态指向 `.worktrees/<分支>`，其它会话继续用主工作区。
4. **合并指定分支**：`mergeBranch` 要求工作区干净且当前分支等于调用方给出的基线。没有新提交时不合并。冲突时 `git merge --abort`，结果停在调用方，不自动解冲突。
