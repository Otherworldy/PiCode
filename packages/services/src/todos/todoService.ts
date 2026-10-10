import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IGitService } from "#src/git/git.js";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type {
  ModelSelection,
  TodoAttachment,
  TodoCreateParams,
  TodoItem,
  TodoUpdateParams,
} from "@zcode/shared";
import { TodoRepo } from "#src/todos/todoRepo.js";
import { TodoStateError, type ITodoService } from "#src/todos/todo.js";

const STANDING_RULE = "不要提交、合并、变基或推送。改动留在工作区，合并时再提交。";

export interface TodoSessionPort {
  create(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    workingDirectory: string;
    text: string;
    attachments?: AttachmentRef[];
    modelSelection: ModelSelection;
  }): Promise<{ sessionId: string }>;
  continue(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    text: string;
    modelSelection: ModelSelection;
  }): Promise<void>;
}

async function materializeAttachments(
  id: string,
  attachments: TodoAttachment[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const [index, file] of attachments.entries()) {
    // 正文优先。剪贴板留下的 localPath 往往已经没了，不能拿它盖住图片。
    let ref = file.dataBase64 ? undefined : file.localPath;
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
  const norm = (value: string) =>
    resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
    > &
      Partial<Pick<IGitService, "getChanges" | "generateCommitMessage" | "stagePaths" | "commit">>,
    private readonly sessions: TodoSessionPort,
  ) {}

  create(params: TodoCreateParams): Promise<TodoItem> {
    return this.repo.create(params);
  }

  update(id: string, params: TodoUpdateParams): Promise<TodoItem> {
    return this.repo.update(id, params);
  }

  list(workspaceKey?: string): Promise<TodoItem[]> {
    return this.repo.list(workspaceKey);
  }

  setTags(id: string, tags: string[]): Promise<TodoItem> {
    return this.repo.setTags(id, tags);
  }

  listTags(): Promise<string[]> {
    return this.repo.listTags();
  }

  async start(id: string, modelSelection: ModelSelection): Promise<TodoItem> {
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
          modelSelection,
        });
        return claimed;
      }
      if (claimed.worktreePath && claimed.branchName && claimed.baseBranch && claimed.baseCommit) {
        const session = await this.sessions.create({
          workspacePath: claimed.workspacePath,
          workspaceIdentity: claimed.workspaceIdentity,
          workingDirectory: claimed.worktreePath,
          text: `关联会话已经删除。请在同一分支上继续完成。\n\n${claimed.prompt}\n\n${STANDING_RULE}`,
          modelSelection,
        });
        return await this.repo.attachRun(claimed.id, {
          baseBranch: claimed.baseBranch,
          baseCommit: claimed.baseCommit,
          branchName: claimed.branchName,
          worktreePath: claimed.worktreePath,
          sessionId: session.sessionId,
        });
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
        modelSelection,
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

  async alignSessions(sessions: readonly { sessionId: string; running: boolean }[]): Promise<void> {
    for (const session of sessions) {
      if (!session.sessionId) continue;
      await this.repo.noteSessionActivity(session.sessionId, session.running);
    }
  }

  settle(sessionId: string, outcome: "completed" | "failed"): Promise<TodoItem | null> {
    return this.repo.settle(sessionId, outcome);
  }

  noteSessionRemoved(sessionId: string): Promise<TodoItem | null> {
    return this.repo.noteSessionRemoved(sessionId);
  }

  async merge(id: string, options?: { commitDirty?: boolean }): Promise<TodoItem> {
    const item = await this.require(id);
    if (
      item.status !== "needs_review" ||
      !item.branchName ||
      !item.baseBranch ||
      !item.baseCommit
    ) {
      throw new TodoStateError("只有待审且已有分支的 To-Do 可以合并");
    }
    const request = {
      workspacePath: item.workspacePath,
      branchName: item.branchName,
      expectedBaseBranch: item.baseBranch,
      baseCommit: item.baseCommit,
    };
    try {
      await this.commitWorktree(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repo.setError(id, message);
      throw new TodoStateError(message);
    }
    let merged = await this.git.mergeBranch(request);
    if (!merged.success && merged.code === "dirty") {
      // mergeBranch 先报脏。提交前再对一次分支，避免把未提交改动写到非基线分支。
      const summary = await this.git.getRepositorySummary({ workspacePath: item.workspacePath });
      if (summary.branchName !== item.baseBranch) {
        merged = {
          success: false,
          code: "wrong-branch",
          message: `主工作区不在 ${item.baseBranch}`,
        };
      } else if (!options?.commitDirty) {
        throw new TodoStateError(merged.message ?? "主工作区有未提交改动", "dirty");
      } else {
        try {
          await this.commitBaseline(item);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.repo.setError(id, message);
          throw new TodoStateError(message);
        }
        merged = await this.git.mergeBranch(request);
      }
    }
    if (!merged.success) {
      await this.repo.setError(id, merged.message ?? merged.code ?? "合并失败");
      if (merged.code === "nothing-to-merge")
        throw new TodoStateError("相对基线没有提交，请改用完成");
      throw new TodoStateError(merged.message ?? "合并失败");
    }
    return (await this.repo.markDone(id))!;
  }

  private async worktreeChangePaths(item: TodoItem): Promise<string[]> {
    const { getChanges } = this.git;
    if (!getChanges || !item.worktreePath) return [];
    const [unstaged, staged] = await Promise.all([
      getChanges({ workspacePath: item.worktreePath, sourceId: "unstaged" }),
      getChanges({ workspacePath: item.worktreePath, sourceId: "staged" }),
    ]);
    return [...new Set([...unstaged, ...staged].map((file) => file.path))];
  }

  /** 会话不提交。合并前把工作树差异写进 To-Do 分支，Git 工具在此之前仍能看到。 */
  private async commitWorktree(item: TodoItem): Promise<void> {
    const { generateCommitMessage, stagePaths, commit } = this.git;
    const paths = await this.worktreeChangePaths(item);
    if (paths.length === 0 || !item.worktreePath) return;
    if (!stagePaths || !commit) throw new TodoStateError("Commit is not available.");
    let message = item.title.trim() || "todo";
    if (generateCommitMessage) {
      try {
        const generated = await generateCommitMessage({
          workspacePath: item.worktreePath,
          includeUnstaged: true,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        });
        const text = generated.message.trim();
        if (text) message = text;
      } catch {
        // 模型不可用时用标题，避免合并停在未提交差异上。
      }
    }
    await stagePaths({ workspacePath: item.worktreePath, paths });
    await commit({ workspacePath: item.worktreePath, message });
  }

  private async commitBaseline(item: TodoItem): Promise<void> {
    const { getChanges, generateCommitMessage, stagePaths, commit } = this.git;
    if (!getChanges || !generateCommitMessage || !stagePaths || !commit) {
      throw new TodoStateError("Commit message generation is not available.");
    }
    const [unstaged, staged] = await Promise.all([
      getChanges({ workspacePath: item.workspacePath, sourceId: "unstaged" }),
      getChanges({ workspacePath: item.workspacePath, sourceId: "staged" }),
    ]);
    const paths = [...new Set([...unstaged, ...staged].map((file) => file.path))];
    // ponytail: 只提交变更列表里的文件。空未跟踪文件仍会让工作区保持脏，合并会停下。
    if (paths.length === 0) throw new TodoStateError("没有可提交的改动");
    const generated = await generateCommitMessage({
      workspacePath: item.workspacePath,
      includeUnstaged: true,
      ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    });
    await stagePaths({ workspacePath: item.workspacePath, paths });
    await commit({ workspacePath: item.workspacePath, message: generated.message });
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
    if ((await this.worktreeChangePaths(item)).length > 0) {
      throw new TodoStateError("工作区还有未提交改动，请改用合并");
    }
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
