// 会话执行目录。列表和项目身份仍是父仓库；这里只记 worktree 副本路径。
// ponytail: 进程内表。重启后由 sessions-index 的 workingDirectory（jsonl cwd）回填。

// 三张表都是「进程内缓存」语义（重启由 sessions-index 回填），缓存必须有界：
// 每个会话/工作区一条，长期使用只增不减。
const MAX_SESSION_WORKTREES = 512;
const MAX_DRAFT_WORKTREES = 64;

const bySession = new Map<string, string>();
const draftByWorkspace = new Map<string, string>();
const draftEpoch = new Map<string, number>();

/** Map 迭代器允许在遍历中删除当前元素；按插入顺序淘汰最旧的。 */
function evictOldest<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/** 写入并刷新顺序。`Map.set` 对已存在的 key 不改位置，只按插入顺序淘汰会优先踢掉长期活跃的会话。 */
function touch<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  evictOldest(map, maxEntries);
}
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
  touch(draftByWorkspace, workspaceKey, worktreePath, MAX_DRAFT_WORKTREES);
  touch(draftEpoch, workspaceKey, (draftEpoch.get(workspaceKey) ?? 0) + 1, MAX_DRAFT_WORKTREES);
  emit();
}

export function bindSessionWorktree(sessionId: string, worktreePath: string): void {
  if (bySession.get(sessionId) === worktreePath) return;
  touch(bySession, sessionId, worktreePath, MAX_SESSION_WORKTREES);
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
