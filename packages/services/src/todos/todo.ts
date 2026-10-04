import type {
  ModelSelection,
  TodoCreateParams,
  TodoItem,
  TodoStatus,
  TodoUpdateParams,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ITodoService {
  create(params: TodoCreateParams): Promise<TodoItem>;
  /** 只有未开始（status todo）可以改标题和说明。 */
  update(id: string, params: TodoUpdateParams): Promise<TodoItem>;
  list(workspaceKey?: string): Promise<TodoItem[]>;
  /** 任何状态都能改。用过的标签留在目录里。 */
  setTags(id: string, tags: string[]): Promise<TodoItem>;
  listTags(): Promise<string[]>;
  /** 模型只用于这一次会话，不写进行里。 */
  start(id: string, modelSelection: ModelSelection): Promise<TodoItem>;
  settle(sessionId: string, outcome: "completed" | "failed"): Promise<TodoItem | null>;
  /** 会话已删除。没有对应行则不动。 */
  noteSessionRemoved(sessionId: string): Promise<TodoItem | null>;
  merge(id: string): Promise<TodoItem>;
  complete(id: string): Promise<TodoItem>;
  abandon(id: string, removeWorktree?: boolean): Promise<TodoItem>;
  /** 已放弃的行回到待开始，工作树和会话保留。 */
  restore(id: string): Promise<TodoItem>;
  delete(id: string): Promise<void>;
  /** 启动时把残留 running 标为失败。 */
  recoverInterrupted(): Promise<number>;
}

export const ITodoService = createServiceDescriptor<ITodoService>(ServiceChannels.Todo);

export function workspaceKeyOf(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return params.workspaceIdentity?.trim() || params.workspacePath;
}

export class TodoStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoStateError";
  }
}

export function assertStatus(status: string): TodoStatus {
  if (
    status === "todo" ||
    status === "running" ||
    status === "needs_review" ||
    status === "done" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return status;
  }
  throw new TodoStateError(`unknown status ${status}`);
}
