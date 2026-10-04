export const TODO_STATUSES = [
  "todo",
  "running",
  "needs_review",
  "done",
  "failed",
  "canceled",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoAttachment {
  fileName: string;
  mime: string;
  bytes: number;
  /** 桌面上还在的本地文件。剪贴板不要填，临时路径下次打开就没了。 */
  localPath?: string;
  /** 剪贴板图片等没有稳定路径时的正文。 */
  dataBase64?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  prompt: string;
  attachments: TodoAttachment[];
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  baseBranch: string | null;
  baseCommit: string | null;
  branchName: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  status: TodoStatus;
  error: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TodoCreateParams {
  title: string;
  prompt: string;
  workspacePath: string;
  workspaceIdentity?: string;
  attachments?: TodoAttachment[];
  tags?: string[];
}

/** 只改未开始行的标题、说明和附件。不传附件则保持原附件。标签不在这里。 */
export interface TodoUpdateParams {
  title: string;
  prompt: string;
  attachments?: TodoAttachment[];
}

export const MAX_TODO_TAGS = 8;
const MAX_TODO_TAG_LENGTH = 32;

/** 输入框里尚未确认的文字。英文逗号或中文逗号拆开，空段丢掉。 */
export function splitTodoTagDraft(raw: string): string[] {
  return raw
    .split(/[,\uFF0C]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 空的丢掉，过长或过多直接拒绝。大小写不同只留第一次出现的写法。 */
export function normalizeTodoTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (name.length > MAX_TODO_TAG_LENGTH) {
      throw new Error(`标签不能超过 ${MAX_TODO_TAG_LENGTH} 个字`);
    }
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    if (tags.length >= MAX_TODO_TAGS) throw new Error(`一条 To-Do 最多 ${MAX_TODO_TAGS} 个标签`);
    seen.add(key);
    tags.push(name);
  }
  return tags;
}
