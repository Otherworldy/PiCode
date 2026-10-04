import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IGitService } from "#src/git/git.js";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { TodoAttachment, TodoCreateParams, TodoItem } from "@zcode/shared";
import { TodoRepo } from "#src/todos/todoRepo.js";
import { TodoStateError, type ITodoService } from "#src/todos/todo.js";

const STANDING_RULE = "可以在 To-Do 分支上提交。禁止合并、变基或推送基线分支。";

export interface TodoSessionPort {
  create(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    workingDirectory: string;
    text: string;
    attachments?: AttachmentRef[];
  }): Promise<{ sessionId: string }>;
  continue(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    text: string;
  }): Promise<void>;
}

async function materializeAttachments(
  id: string,
  attachments: TodoAttachment[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const [index, file] of attachments.entries()) {
    let ref = file.localPath;
    if (!ref && file.dataBase64) {
      const dir = join(tmpdir(), "zcode-todos", id);
      await mkdir(dir, { recursive: true });
      const safe = file.fileName.replace(/[^\w.-]+/g, "_") || `file-${index}`;
      ref = join(dir, safe);
      await writeFile(ref, Buffer.from(file.dataBase64, "base64"));
    }
    if (!ref) continue;
    refs.push({ ref, fileName: file.fileName, mime: file.mime, bytes: file.bytes });
  }
  return refs;
}

function samePath(left: string, right: string): boolean {
  const norm = (value: string) => resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(left) === norm(right);
}

export class TodoService implements ITodoService {
  constructor(
    private readonly repo: TodoRepo,
    private readonly git: Pick<
      IGitService,
      | "getRepositorySummary"
      | "listWorktrees"
      | "createWorktree"
      | "removeWorktree"
      | "countCommitsAhead"
      | "mergeBranch"
    >,
    private readonly sessions: TodoSessionPort,
  ) {}

  recoverInterrupted(): Promise<number> {
    return this.repo.failInterrupted();
  }

  create(params: TodoCreateParams): Promise<TodoItem> {
    return this.repo.create(params);
  }

  list(workspaceKey?: string): Promise<TodoItem[]> {
    return this.repo.list(workspaceKey);
  }

  async start(id: string): Promise<TodoItem> {
    const claimed = await this.repo.claim(id);
    if (claimed === "missing") throw new TodoStateError("To-Do 不存在");
    if (claimed === "bad-status") throw new TodoStateError("当前状态不能开始");
    try {
      if (claimed.sessionId && claimed.worktreePath) {
        await this.sessions.continue({
          workspacePath: claimed.workspacePath,
          workspaceIdentity: claimed.workspaceIdentity,
          sessionId: claimed.sessionId,
          text: `上一次执行中断了。请在同一分支上继续完成。\n\n${claimed.prompt}\n\n${STANDING_RULE}`,
        });
        return claimed;
      }
      const summary = await this.git.getRepositorySummary({
        workspacePath: claimed.workspacePath,
      });
      if (!summary.isRepository) throw new TodoStateError("项目不是 Git 仓库");
      if (!samePath(summary.repoRoot, claimed.workspacePath)) {
        throw new TodoStateError("项目必须是仓库根");
      }
      const trees = await this.git.listWorktrees({ workspacePath: claimed.workspacePath });
      const main = trees[0];
      if (!main || !samePath(main.path, claimed.workspacePath)) {
        throw new TodoStateError("不能从已有 worktree 开始");
      }
      if (!summary.branchName || !main.head) throw new TodoStateError("项目不在可用分支上");
      const short = /^todo-\d+$/.test(claimed.id);
      const branchName = short ? claimed.id : `todo/${claimed.id}`;
      const worktreePath = resolve(
        summary.repoRoot,
        ".worktrees",
        short ? claimed.id : `todo-${claimed.id}`,
      );
      const created = await this.git.createWorktree({
        workspacePath: claimed.workspacePath,
        branchName,
        worktreePath,
        startPoint: main.head,
      });
      if (!created.success || !created.worktreePath) {
        throw new TodoStateError(created.issues[0]?.message ?? "创建 worktree 失败");
      }
      const session = await this.sessions.create({
        workspacePath: claimed.workspacePath,
        workspaceIdentity: claimed.workspaceIdentity,
        workingDirectory: created.worktreePath,
        text: `${claimed.prompt}\n\n${STANDING_RULE}`,
        attachments: await materializeAttachments(claimed.id, claimed.attachments),
      });
      return await this.repo.attachRun(claimed.id, {
        baseBranch: summary.branchName,
        baseCommit: main.head,
        branchName,
        worktreePath: created.worktreePath,
        sessionId: session.sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repo.markFailed(claimed.id, message);
      throw error;
    }
  }

  settle(sessionId: string, outcome: "completed" | "failed"): Promise<TodoItem | null> {
    return this.repo.settle(sessionId, outcome);
  }

  async merge(id: string): Promise<TodoItem> {
    const item = await this.require(id);
    if (item.status !== "needs_review" || !item.branchName || !item.baseBranch || !item.baseCommit) {
      throw new TodoStateError("只有待审且已有分支的 To-Do 可以合并");
    }
    const merged = await this.git.mergeBranch({
      workspacePath: item.workspacePath,
      branchName: item.branchName,
      expectedBaseBranch: item.baseBranch,
      baseCommit: item.baseCommit,
    });
    if (!merged.success) {
      await this.repo.setError(id, merged.message ?? merged.code ?? "合并失败");
      if (merged.code === "nothing-to-merge") throw new TodoStateError("相对基线没有提交，请改用完成");
      throw new TodoStateError(merged.message ?? "合并失败");
    }
    return (await this.repo.markDone(id))!;
  }

  async complete(id: string): Promise<TodoItem> {
    const item = await this.require(id);
    if (item.status !== "needs_review" || !item.branchName || !item.baseCommit) {
      throw new TodoStateError("只有待审可以完成");
    }
    const ahead = await this.git.countCommitsAhead({
      workspacePath: item.workspacePath,
      baseCommit: item.baseCommit,
      branchName: item.branchName,
    });
    if (ahead > 0) throw new TodoStateError("已有提交，不能直接完成");
    return (await this.repo.markDone(id))!;
  }

  async restore(id: string): Promise<TodoItem> {
    const next = await this.repo.restore(id);
    return next!;
  }

  async abandon(id: string, removeWorktree = false): Promise<TodoItem> {
    const item = await this.require(id);
    const next = await this.repo.abandon(id);
    if (removeWorktree && item.worktreePath) {
      await this.git.removeWorktree({
        workspacePath: item.workspacePath,
        worktreePath: item.worktreePath,
      });
    }
    return next!;
  }

  delete(id: string): Promise<void> {
    return this.repo.delete(id);
  }

  private async require(id: string): Promise<TodoItem> {
    const item = await this.repo.get(id);
    if (!item) throw new TodoStateError("To-Do 不存在");
    return item;
  }
}
