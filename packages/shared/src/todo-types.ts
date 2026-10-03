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
  /** 桌面本地路径。有它就不存正文。 */
  localPath?: string;
  /** 剪贴板图片等没有路径时的正文。 */
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
  createdAt: number;
  updatedAt: number;
}

export interface TodoCreateParams {
  title: string;
  prompt: string;
  workspacePath: string;
  workspaceIdentity?: string;
  attachments?: TodoAttachment[];
}
