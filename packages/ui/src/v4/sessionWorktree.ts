// 会话执行目录。列表和项目身份仍是父仓库；这里只记 worktree 副本路径。
// ponytail: 进程内表。重启后由 sessions-index 的 workingDirectory（jsonl cwd）回填。

const bySession = new Map<string, string>();
const draftByWorkspace = new Map<string, string>();
const draftEpoch = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeSessionWorktrees(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bindDraftWorktree(workspaceKey: string, worktreePath: string): void {
  draftByWorkspace.set(workspaceKey, worktreePath);
  draftEpoch.set(workspaceKey, (draftEpoch.get(workspaceKey) ?? 0) + 1);
  emit();
}

export function bindSessionWorktree(sessionId: string, worktreePath: string): void {
  if (bySession.get(sessionId) === worktreePath) return;
  bySession.set(sessionId, worktreePath);
  emit();
}

export function draftWorktree(workspaceKey: string): string | null {
  return draftByWorkspace.get(workspaceKey) ?? null;
}

export function draftWorktreeEpoch(workspaceKey: string): number {
  return draftEpoch.get(workspaceKey) ?? 0;
}

/** 已打开的会话优先；草稿（sessionId 为空）用当前 workspace 上待绑定的 worktree。 */
export function workingDirectoryFor(
  workspaceKey: string,
  sessionId: string | null,
): string | null {
  if (sessionId) return bySession.get(sessionId) ?? null;
  return draftByWorkspace.get(workspaceKey) ?? null;
}

export function sessionWorktreePath(sessionId: string): string | null {
  return bySession.get(sessionId) ?? null;
}

/** Git 卡片和切分支必须用会话 worktree。用主工作区的话，一点开当前分支就变成 main。 */
export function sessionGitDirectory(workspacePath: string, sessionId: string | null): string {
  if (!sessionId) return workspacePath;
  const cwd = sessionWorktreePath(sessionId);
  return cwd && isWorkspaceWorktree(workspacePath, cwd) ? cwd : workspacePath;
}

export function worktreeBranchLabel(worktreePath: string): string {
  const normalized = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || worktreePath;
}

/** 只接受父仓库 `.worktrees/` 下的副本，避免把 Git 查询指到仓库外。 */
export function isWorkspaceWorktree(workspacePath: string, candidate: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(candidate).startsWith(`${norm(workspacePath)}/.worktrees/`);
}
