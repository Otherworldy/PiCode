import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ConversationDelta, DeliveryProfileName } from "@zcode/shared/zcode-protocol-v4";
import { CommandBridge, piHostBlocksResidency, type SubmissionModel } from "./command-bridge.js";
import { createHostExtensionUi } from "./extension-ui-bridge.js";
import { textOfMessageContent } from "./plan-review-signal.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { HostQueue } from "./host-queue.js";
import { workspaceKey } from "./identity.js";
import { readPiJsonl, shouldApplyStoredSessionTitle } from "./jsonl-history.js";
import {
  installPlannotatorEmbeddedBrowserRedirect,
  notePlannotatorBrowserSession,
  registerPlannotatorBrowserSession,
} from "./plannotator-browser-redirect.js";
import {
  abortLiveSubagent,
  getLiveSubagentModel,
  hasLiveSubagent,
  setLiveSubagentModel,
  subagentControlWorks,
  subscribeLiveSubagents,
} from "./live-subagents.js";
import {
  listPiSubagentChildren,
  piSubagentRevision,
  type PiSubagentChild,
} from "./pi-subagent-index.js";
import { mapThought } from "./model-delegate.js";
import { PiToV4Projector } from "./projector.js";
import type { ToolPermissionCheck } from "./permission-gate.js";
import { scheduleLiveSessionTitleSummary } from "./session-title-live.js";
import { shouldAutoSummarizeTitle } from "./session-title-summary.js";
import { runSessionResume } from "./session-tree.js";
import {
  contextUsagePublish,
  type CreatePiSession,
  type PiExtensionUiResponse,
  type PiHostEvent,
  type PiSessionPort,
  type PiSessionTreeNode,
  type PiSkillView,
  type PiSlashCommandView,
  type SessionResumeRequest,
  type SessionResumeResult,
} from "./types.js";

export interface HostedSession {
  readonly sessionId: string;
  readonly identity: string;
  readonly workspacePath: string;
  /** Agent 实际 cwd。worktree 会话不是 workspacePath。 */
  readonly cwd: string;
  readonly sessionFile: string;
  readonly parentSessionId?: string;
  readonly workId?: string;
  readonly projector: PiToV4Projector;
  readonly queue: HostQueue;
  readonly ui: ExtensionUiHost;
  readonly bridge: CommandBridge;
  readonly viaRegistry: boolean;
  listModels(): Array<{ providerId: string; modelId: string }>;
  listSkills(): PiSkillView[];
  listSlashCommands(): PiSlashCommandView[];
  readonly isIdle: boolean;
  /** 常驻池唯一读的忙闲事实。投影 phase 不是 running 时也要算上 Pi 自己还在跑。 */
  readonly hasResidencyBlockingWork: boolean;
  prompt(text: string): Promise<boolean>;
  waitTurn(): Promise<void>;
  abort(): Promise<void>;
  continueAfterError(): Promise<void>;
  cancelManagedProcess(workId: string): Promise<"killed" | "missing" | "unrelated">;
  setRunningSubagentModel(input: {
    childSessionId: string;
    provider: string;
    model: string;
    thought: string;
  }): Promise<boolean>;
  readManagedProcessOutput(
    workId: string,
  ): Promise<import("@zcode/shared").BackgroundBashOutputResult>;
  compact(): Promise<void>;
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{ cancelled?: boolean } | void>;
  resumeAt(request: SessionResumeRequest): Promise<SessionResumeResult>;
  captureAbandonedBranch(
    request: SessionResumeRequest,
  ): { entries: readonly unknown[] } | undefined;
  /** 叶子已经裁好。摘要写在这个会话上，取消只撤掉「正在总结」。 */
  summarizeAbandoned(
    captured: { entries: readonly unknown[] },
    request: SessionResumeRequest,
  ): Promise<void>;
  noteBranchSummary(active: boolean): void;
  readSessionTree(): PiSessionTreeNode[];
  labelSessionEntry(entryId: string, label?: string): PiSessionTreeNode[];
  deleteSessionBranch(entryId: string): PiSessionTreeNode[];
  branchFrom?(entryId: string): { sessionId: string; sessionFile: string };
  reloadHistory(content: string): void;
  setModel(provider: string, modelId: string, thought?: string): Promise<void>;
  setThinkingLevel(level: string): void;
  setSessionName(name: string): void;
  /** 把手改标题写进投影并通知侧栏。只改 session 文件的话，当前列表仍显示旧标题。 */
  publishCustomTitle(title: string): void;
  setFeedback(entityId: string, feedback: "like" | "dislike" | null): void;
  markTurnFilesReverted(turnId: string): void;
  requestConfirm(toolName: string, reason: string, args?: unknown): Promise<boolean>;
  /** 本会话里点过「允许本会话」的工具。 */
  readonly sessionAllows: Set<string>;
  /** 从此处继续：新会话沿用原会话的模式和已允许工具。 */
  applyAccessFrom(source: HostedSession): void;
  /** 立刻改这个会话的权限。完全访问会放掉正在等的工具授权。 */
  setCollaborationMode(mode: string): void;
  publishUi(): void;
  dispose(): void | Promise<void>;
  hydrateHistory(content: string): void;
  onDeltas(listener: (deltas: ConversationDelta[]) => void): () => void;
  onNotify(
    listener: (message: string, notifyType: "info" | "warning" | "error") => void,
  ): () => void;
}

export type PiStoredSummary = {
  sessionId: string;
  sessionFile: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  lastAssistantPreview?: string;
  cwd?: string;
};

let abortInflightNetwork = (): void => undefined;

/** bootstrap 把代理 fetch 的取消接进来。Pi abort 信号到不了 socket 时，Stop 仍能拆掉请求。 */
export function setInflightNetworkAbort(abort: () => void): void {
  abortInflightNetwork = abort;
}

export type PiStoredSession = {
  sessionId: string;
  sessionFile: string;
  identity: string;
  workspacePath: string;
};

export interface RegistryOptions {
  storageRoot: string;
  createSession: CreatePiSession;
  profile?: DeliveryProfileName;
  loadExtensions?: boolean;
  createToolPermission?: (hosted: HostedSession) => ToolPermissionCheck;
  /** Pi 原生会话根目录，缺省 `~/.pi/agent/sessions`。测试可注入。 */
  nativeSessionsRoot?: string;
  /**
   * 协议宿主把 Plannotator 的审查页交给内置浏览器。
   * 纯 CLI 不打开，插件继续用本机浏览器。
   */
  redirectPlannotatorToEmbeddedBrowser?: boolean;
}

const execFileAsync = promisify(execFile);

/** 只接受本仓库已注册的 worktree。其它路径回落到 workspace，避免会话 cwd 被指到仓库外。 */
export async function acceptedWorkingDirectory(
  workspacePath: string,
  workingDirectory?: string,
): Promise<string> {
  const home = resolve(workspacePath);
  if (!workingDirectory) return home;
  const wanted = resolve(workingDirectory);
  if (wanted === home) return home;
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: home,
      timeout: 5000,
      windowsHide: true,
    });
    const listed = stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length).trim()));
    if (listed.includes(wanted)) return wanted;
  } catch {
    // git 不可用或不是仓库：不接受覆盖。
  }
  return home;
}

function encodeKey(identity: string): string {
  return Buffer.from(identity).toString("base64url");
}

function nativeSessionsRoot(override?: string): string {
  return override ?? join(homedir(), ".pi", "agent", "sessions");
}

function nativeSessionDir(cwd: string, root: string): string {
  // remote identity 以 remote: 开头。path.resolve 会把它变成当前盘下的相对路径，
  // 和真正的远端 cwd（又会被解析成 C:\root\...）不是同一个目录，侧栏就找不到会话。
  const encoded = cwd.startsWith("remote:") ? cwd : resolve(cwd);
  const safePath = `--${encoded.replace(/^[\\/]/u, "").replace(/[\\/:]/gu, "-")}--`;
  return join(root, safePath);
}

function fileStem(file: string): string {
  return file.replace(/\.jsonl$/u, "");
}

function piSessionFileName(sessionId: string, at = new Date()): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

function permissionAllowed(response: PiExtensionUiResponse): boolean {
  if ("cancelled" in response) return false;
  if ("confirmed" in response) return response.confirmed;
  if (!("value" in response)) return false;
  return response.value !== "deny" && response.value !== "no" && response.value !== "";
}

function branchedSessionTitle(parentTitle: string): string {
  const title = parentTitle.trim();
  return title ? `分支-${title}` : "分支";
}

function assertBranchSummaryIdle(projector: PiToV4Projector): void {
  if (!projector.isBranchSummaryRunning()) return;
  // 总结被丢下的分支时，这个会话不能再分叉或再开一条分支。停止不走这里。
  throw Object.assign(new Error("Wait for the branch summary to finish"), {
    reasonCode: "guard.sessionTreeBusy",
  });
}

export class HostSessionRegistry {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly children = new Map<string, Set<string>>();
  private readonly toolChecks = new Map<string, ToolPermissionCheck>();

  constructor(private readonly options: RegistryOptions) {
    if (options.redirectPlannotatorToEmbeddedBrowser) {
      installPlannotatorEmbeddedBrowserRedirect();
    }
  }

  get(sessionId: string): HostedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async create(input: {
    workspaceIdentity?: string | null;
    workspacePath: string;
    workingDirectory?: string;
    sessionId?: string;
    parentSessionId?: string;
    viaRegistry?: boolean;
    omitHostExtensions?: boolean;
  }): Promise<HostedSession> {
    if (input.sessionId) {
      const existing = this.sessions.get(input.sessionId);
      if (existing) return existing;
      const stored = await this.find(input.sessionId);
      if (stored) {
        return this.openFile({
          sessionId: stored.sessionId,
          identity: stored.identity,
          workspacePath: input.workspacePath,
          cwd: stored.workspacePath,
          sessionFile: stored.sessionFile,
          parentSessionId: input.parentSessionId,
          viaRegistry: input.viaRegistry,
          omitHostExtensions: input.omitHostExtensions,
        });
      }
    }
    const identity = workspaceKey(input.workspaceIdentity, input.workspacePath);
    const sessionId = input.sessionId ?? randomUUID();
    const dir = nativeSessionDir(identity, nativeSessionsRoot(this.options.nativeSessionsRoot));
    await mkdir(dir, { recursive: true });
    const cwd = await acceptedWorkingDirectory(input.workspacePath, input.workingDirectory);
    return this.openFile({
      sessionId,
      identity,
      workspacePath: input.workspacePath,
      cwd,
      sessionFile: join(dir, piSessionFileName(sessionId)),
      parentSessionId: input.parentSessionId,
      viaRegistry: input.viaRegistry,
      omitHostExtensions: input.omitHostExtensions,
    });
  }

  async spawn(parentId: string): Promise<HostedSession> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    return this.create({
      workspaceIdentity: parent.identity,
      workspacePath: parent.workspacePath,
      parentSessionId: parentId,
      viaRegistry: true,
      omitHostExtensions: true,
    });
  }

  async fork(parentId: string, entryId: string): Promise<HostedSession> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    assertBranchSummaryIdle(parent.projector);
    const title = branchedSessionTitle(parent.projector.getSnapshot().meta.title);
    if (parent.branchFrom) {
      const branched = parent.branchFrom(entryId);
      const child = await this.openFile({
        sessionId: branched.sessionId,
        identity: parent.identity,
        workspacePath: parent.workspacePath,
        sessionFile: branched.sessionFile,
        parentSessionId: parentId,
        viaRegistry: true,
      });
      child.publishCustomTitle(title);
      return child;
    }
    const sessionId = randomUUID();
    const dir = nativeSessionDir(
      parent.identity,
      nativeSessionsRoot(this.options.nativeSessionsRoot),
    );
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, piSessionFileName(sessionId));
    await copyFile(parent.sessionFile, sessionFile).catch(() => undefined);
    const hosted = await this.openFile({
      sessionId,
      identity: parent.identity,
      workspacePath: parent.workspacePath,
      sessionFile,
      viaRegistry: true,
    });
    await hosted.navigateTree(entryId);
    hosted.publishCustomTitle(title);
    return hosted;
  }

  /** 从此处继续：复制到当前叶子，再只在新会话上导航。原会话叶子不动。 */
  async resumeIntoNewSession(
    parentId: string,
    request: SessionResumeRequest,
  ): Promise<
    | { cancelled: true }
    | {
        cancelled: false;
        sessionId: string;
        hosted: HostedSession;
        editorText?: string;
        tree: SessionResumeResult["tree"];
      }
  > {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    assertBranchSummaryIdle(parent.projector);
    const leaf = parent.readSessionTree().find((node) => node.leaf);
    if (!leaf) {
      throw Object.assign(new Error("Entry not found"), {
        reasonCode: "guard.sessionTreeEntryMissing",
      });
    }
    const child = await this.fork(parentId, leaf.id);
    child.applyAccessFrom(parent);
    // 先记下丢掉的路径，再裁切。裁完叶子已经停在目标上，再收集就空了。
    const captured = request.summarize ? child.captureAbandonedBranch(request) : undefined;
    const previousAbort = parent.abort;
    const restoreAbort = () => {
      parent.abort = previousAbort;
    };
    parent.abort = () => child.abort();
    try {
      const result = await child.resumeAt({ ...request, summarize: false });
      if (result.cancelled) {
        restoreAbort();
        await this.delete(child.sessionId);
        return { cancelled: true };
      }
      if (captured) {
        // 回执先返回，界面才能先进入新会话。摘要接着写在新会话里。
        void child.summarizeAbandoned(captured, request).finally(restoreAbort);
      } else {
        restoreAbort();
      }
      return {
        cancelled: false,
        sessionId: child.sessionId,
        hosted: child,
        ...(result.editorText ? { editorText: result.editorText } : {}),
        tree: result.tree,
      };
    } catch (error) {
      restoreAbort();
      await this.delete(child.sessionId).catch(() => undefined);
      throw error;
    }
  }

  async abort(workId: string): Promise<boolean> {
    const child = this.sessions.get(workId);
    if (!child?.parentSessionId) return false;
    await child.abort();
    return true;
  }

  async delete(sessionId: string, identity?: string): Promise<boolean> {
    const files = new Set<string>();
    const hosted = this.sessions.get(sessionId);
    if (hosted) {
      files.add(hosted.sessionFile);
      await hosted.abort().catch(() => undefined);
      await hosted.dispose();
      this.sessions.delete(sessionId);
      this.toolChecks.delete(sessionId);
      this.children.delete(sessionId);
      for (const ids of this.children.values()) ids.delete(sessionId);
    }
    if (identity) {
      const sessionsRoot = nativeSessionsRoot(this.options.nativeSessionsRoot);
      const dirs: Array<{ dir: string; idFrom: "file" | "header" }> = [
        {
          dir: join(this.options.storageRoot, "pi-host-sessions", encodeKey(identity)),
          idFrom: "file",
        },
        { dir: nativeSessionDir(identity, sessionsRoot), idFrom: "header" },
      ];
      const legacyRemotePath = identity.startsWith("remote:")
        ? identity.slice(identity.indexOf(":/") + 1)
        : "";
      if (legacyRemotePath.startsWith("/") && legacyRemotePath !== "/") {
        dirs.push({ dir: nativeSessionDir(legacyRemotePath, sessionsRoot), idFrom: "header" });
      }
      for (const { dir, idFrom } of dirs) {
        for (const item of await this.listDir(dir, idFrom)) {
          if (item.sessionId === sessionId) files.add(item.sessionFile);
        }
      }
    } else if (!hosted) {
      const stored = await this.find(sessionId);
      if (stored) files.add(stored.sessionFile);
    }
    if (files.size === 0) return false;
    await Promise.all([...files].map((file) => rm(file, { force: true })));
    return true;
  }

  async list(identity: string): Promise<PiStoredSummary[]> {
    const hosted = await this.listDir(
      join(this.options.storageRoot, "pi-host-sessions", encodeKey(identity)),
      "file",
    );
    const sessionsRoot = nativeSessionsRoot(this.options.nativeSessionsRoot);
    const native = await this.listDir(nativeSessionDir(identity, sessionsRoot), "header");
    // 旧文件写在 path.resolve(远端路径) 下，Windows 上是 C:\root\...。新文件按 identity 存。
    const legacyRemotePath = identity.startsWith("remote:")
      ? identity.slice(identity.indexOf(":/") + 1)
      : "";
    const legacy =
      legacyRemotePath.startsWith("/") && legacyRemotePath !== "/"
        ? await this.listDir(nativeSessionDir(legacyRemotePath, sessionsRoot), "header")
        : [];
    const byId = new Map<string, PiStoredSummary>();
    for (const item of [...hosted, ...native, ...legacy]) byId.set(item.sessionId, item);
    return [...byId.values()];
  }

  async find(sessionId: string): Promise<PiStoredSession | null> {
    const hostedRoot = join(this.options.storageRoot, "pi-host-sessions");
    const hosted = await this.findInRoot(hostedRoot, sessionId, {
      decodeDir: true,
      match: "file",
    });
    if (hosted) return hosted;
    return this.findInRoot(nativeSessionsRoot(this.options.nativeSessionsRoot), sessionId, {
      decodeDir: false,
      match: "header",
    });
  }

  private async openFile(input: {
    sessionId: string;
    identity: string;
    workspacePath: string;
    cwd?: string;
    sessionFile: string;
    parentSessionId?: string;
    viaRegistry?: boolean;
    omitHostExtensions?: boolean;
  }): Promise<HostedSession> {
    const live = this.sessions.get(input.sessionId);
    if (live) return live;
    const pi = await this.options.createSession({
      sessionId: input.sessionId,
      cwd: input.cwd ?? input.workspacePath,
      sessionFile: input.sessionFile,
      parentSessionId: input.parentSessionId,
      omitHostExtensions: input.omitHostExtensions,
      loadExtensions: this.options.loadExtensions ?? true,
      checkPermission: async (request) => {
        const check = this.toolChecks.get(input.sessionId);
        if (!check) return "allow";
        return check(request);
      },
    });
    const hosted = this.wrap(pi, {
      sessionId: input.sessionId,
      identity: input.identity,
      workspacePath: input.workspacePath,
      cwd: input.cwd ?? input.workspacePath,
      sessionFile: pi.sessionFile ?? input.sessionFile,
      parentSessionId: input.parentSessionId,
      viaRegistry: input.viaRegistry ?? Boolean(input.parentSessionId),
      workId: input.parentSessionId ? input.sessionId : undefined,
    });
    return this.register(hosted);
  }

  private async listDir(dir: string, idFrom: "file" | "header"): Promise<PiStoredSummary[]> {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const summaries: PiStoredSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionFile = join(dir, file);
      const content = await readFile(sessionFile, "utf8").catch(() => "");
      const summary = readPiJsonl(content).summary;
      if (!summary) continue;
      const stem = fileStem(file);
      const headerId = summary.sessionId;
      // Pi 分叉文件名是 timestamp_id。用整段文件名当会话 id 会和活会话的 header id 不是同一行。
      const sessionId =
        headerId && (idFrom === "header" || stem.endsWith(`_${headerId}`)) ? headerId : stem;
      summaries.push({
        sessionId,
        sessionFile,
        title: summary.title,
        createdAt: summary.createdAt,
        lastActivityAt: summary.lastActivityAt,
        ...(summary.lastAssistantPreview
          ? { lastAssistantPreview: summary.lastAssistantPreview }
          : {}),
        ...(summary.cwd ? { cwd: summary.cwd } : {}),
      });
    }
    return summaries;
  }

  private async findInRoot(
    root: string,
    sessionId: string,
    options: { decodeDir: boolean; match: "file" | "header" },
  ): Promise<PiStoredSession | null> {
    let dirs: string[] = [];
    try {
      dirs = await readdir(root);
    } catch {
      return null;
    }
    for (const dir of dirs) {
      const folder = join(root, dir);
      if (options.match === "file") {
        const sessionFile = join(folder, `${sessionId}.jsonl`);
        const hit = await this.readStored(sessionFile, sessionId, dir, options.decodeDir);
        if (hit) return hit;
        continue;
      }
      let files: string[] = [];
      try {
        files = await readdir(folder);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionFile = join(folder, file);
        const hit = await this.readStored(sessionFile, sessionId, dir, options.decodeDir);
        if (hit) return hit;
      }
      if (options.match === "header") {
        const nested = await this.findNestedJsonl(folder, sessionId, dir, 3);
        if (nested) return nested;
      }
    }
    return null;
  }

  private async findNestedJsonl(
    folder: string,
    sessionId: string,
    dir: string,
    depth: number,
  ): Promise<PiStoredSession | null> {
    if (depth < 0) return null;
    let entries: string[] = [];
    try {
      entries = await readdir(folder);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(folder, entry);
      if (entry.endsWith(".jsonl")) {
        const hit = await this.readStored(full, sessionId, dir, false);
        if (hit) return hit;
        continue;
      }
      const nested = await this.findNestedJsonl(full, sessionId, dir, depth - 1);
      if (nested) return nested;
    }
    return null;
  }

  private async readStored(
    sessionFile: string,
    sessionId: string,
    dir: string,
    decodeDir: boolean,
  ): Promise<PiStoredSession | null> {
    const content = await readFile(sessionFile, "utf8").catch(() => "");
    if (!content) return null;
    const summary = readPiJsonl(content).summary;
    if (!summary) return null;
    const headerId = summary.sessionId;
    const stem = fileStem(sessionFile.split(/[\\/]/u).pop() ?? "");
    if (stem !== sessionId && headerId !== sessionId) return null;
    let identity = dir;
    if (decodeDir) {
      try {
        identity = Buffer.from(dir, "base64url").toString("utf8") || dir;
      } catch {
        identity = dir;
      }
    } else {
      identity = summary.cwd ?? dir;
    }
    return {
      sessionId,
      sessionFile,
      identity,
      workspacePath: summary.cwd ?? identity,
    };
  }

  private async register(hosted: HostedSession): Promise<HostedSession> {
    const content = await readFile(hosted.sessionFile, "utf8").catch(() => "");
    hosted.hydrateHistory(content);
    this.sessions.set(hosted.sessionId, hosted);
    if (this.options.createToolPermission) {
      this.toolChecks.set(hosted.sessionId, this.options.createToolPermission(hosted));
    }
    if (hosted.parentSessionId) {
      const set = this.children.get(hosted.parentSessionId) ?? new Set();
      set.add(hosted.sessionId);
      this.children.set(hosted.parentSessionId, set);
    }
    return hosted;
  }

  private wrap(
    pi: PiSessionPort,
    meta: {
      sessionId: string;
      identity: string;
      workspacePath: string;
      cwd: string;
      sessionFile: string;
      parentSessionId?: string;
      viaRegistry: boolean;
      workId?: string;
    },
  ): HostedSession {
    const queue = new HostQueue();
    const ui = new ExtensionUiHost();
    const projector = new PiToV4Projector(meta.sessionId, `epoch:${meta.sessionId}`, {
      profile: this.options.profile,
      viaRegistry: meta.viaRegistry,
      workId: meta.workId,
    });
    const deltaListeners = new Set<(deltas: ConversationDelta[]) => void>();
    const notifyListeners = new Set<
      (message: string, notifyType: "info" | "warning" | "error") => void
    >();
    const pendingDeltas: ConversationDelta[] = [];
    const sessionAllowed = new Set<string>();
    const setCollaborationMode = (mode: string) => {
      ui.autoConfirm = mode === "yolo";
      const released = mode === "yolo" && ui.allowPendingApprovals();
      if (mode && mode !== projector.getSnapshot().config.mode) {
        emit(projector.setConfig({ mode }));
      }
      if (released) emit(projector.replaceInteractions(ui.snapshot().pending));
    };
    const emit = (deltas: ConversationDelta[]) => {
      if (deltas.length === 0) return;
      if (deltaListeners.size === 0) {
        for (const delta of deltas) pendingDeltas.push(delta);
        return;
      }
      for (const listener of deltaListeners) listener(deltas);
    };
    const unregisterBrowser = this.options.redirectPlannotatorToEmbeddedBrowser
      ? registerPlannotatorBrowserSession(meta.sessionId, (url) => {
          emit([{ op: "embeddedBrowser.open", url }]);
        })
      : () => undefined;
    // 入队、删除、改写都走 replaceQueue。不推出去，界面看不到，也取消不了。
    projector.bindQueuePublish(emit);
    const applyModel = async (selection: SubmissionModel) => {
      const provider = selection.providerId.trim();
      const modelId = selection.modelId.trim();
      if (!provider || !modelId) return;
      const config = projector.getSnapshot().config;
      const thought = selection.thought?.trim();
      if (config.provider === provider && config.model === modelId) {
        if (thought && thought !== config.thought) {
          pi.setThinkingLevel?.(mapThought(thought));
          emit(projector.setConfig({ thought }));
        }
        return;
      }
      const applied = await pi.setModel?.(provider, modelId, thought);
      if (applied === false) return;
      emit(
        projector.setConfig({
          provider,
          model: modelId,
          ...(thought ? { thought } : {}),
        }),
      );
    };
    const bridge = new CommandBridge(pi, queue, applyModel, (attachments) => {
      projector.noteUserAttachments(attachments);
    });
    const publishContext = () => {
      const usage = pi.contextUsage?.();
      if (!usage) return;
      emit(projector.setContextUsage(usage.used, usage.max, usage.breakdown));
    };
    let contextTimer: ReturnType<typeof setTimeout> | undefined;
    const publishContextNow = () => {
      if (contextTimer) {
        clearTimeout(contextTimer);
        contextTimer = undefined;
      }
      publishContext();
    };
    // ponytail: 250ms。Pi 每帧重绘；再密也只是字符估算。
    const publishContextSoon = () => {
      if (contextTimer) return;
      contextTimer = setTimeout(() => {
        contextTimer = undefined;
        publishContext();
      }, 250);
    };
    const handleUi = (event: Extract<PiHostEvent, { type: "extension_ui_request" }>) => {
      const next = ui.handle(event);
      emit(projector.replaceInteractions(next.pending));
      emit(projector.replaceWidgets(next.widgets));
      emit(projector.replaceStatuses(next.statuses));
      for (const effect of next.sideEffects) {
        if (effect.kind === "notify") {
          for (const listener of notifyListeners) listener(effect.message, effect.notifyType);
        }
        if (effect.kind === "title") emit(projector.setTitle(effect.title, "generated"));
      }
    };
    let subagentKey = "";
    let subagentPublishGen = 0;
    const cancelledSubagents = new Set<string>();
    let subagentTimer: ReturnType<typeof setTimeout> | undefined;
    const publishSubagents = async () => {
      if (!meta.sessionFile) return;
      const gen = ++subagentPublishGen;
      const children = await listPiSubagentChildren({
        parentSessionFile: meta.sessionFile,
        parentSessionId: meta.sessionId,
      }).catch(() => [] as PiSubagentChild[]);
      if (gen !== subagentPublishGen) return;
      const running = children.filter(
        (child) =>
          child.status === "running" || child.status === "waiting" || child.status === "blocked",
      );
      for (const id of cancelledSubagents) {
        const child = children.find((item) => item.childSessionId === id);
        // 文件还没被扫到时不能忘掉取消，否则这一行会又出现在「正在运行」。
        if (child && !running.includes(child)) cancelledSubagents.delete(id);
      }
      // 用户已经按下停止。磁盘状态还没落成终态时，不要把它留在「正在运行」。
      const visibleRunning = running.filter(
        (child) => !cancelledSubagents.has(child.childSessionId),
      );
      const next = {
        revision: piSubagentRevision(children),
        childSessionIds: children.map((child) => child.childSessionId),
        running: visibleRunning.map((child) => {
          const model = getLiveSubagentModel(child.childSessionId);
          return {
            childSessionId: child.childSessionId,
            subagentType: child.subagentType,
            title: child.title,
            status: child.status as "running" | "waiting" | "blocked",
            ...(child.summary ? { summary: child.summary } : {}),
            ...(child.startedAt ? { startedAt: child.startedAt } : {}),
            ...(model
              ? {
                  modelProvider: model.provider,
                  modelId: model.model,
                  ...(model.thought ? { thought: model.thought } : {}),
                }
              : {}),
          };
        }),
        endedTotal: children.length - visibleRunning.length,
      };
      const key = JSON.stringify(next);
      if (key !== subagentKey) {
        subagentKey = key;
        emit(projector.replaceSubagents(next));
      }
      // 目录没变也要刷新停止句柄：子会话已经 abort，文件看起来还在跑。
      emit(projector.replaceSubagentWorks(subagentControlWorks(visibleRunning, hasLiveSubagent)));
    };
    const scheduleSubagents = () => {
      if (subagentTimer) clearTimeout(subagentTimer);
      subagentTimer = setTimeout(() => {
        subagentTimer = undefined;
        void publishSubagents();
      }, 400);
    };
    let subagentPoll: ReturnType<typeof setInterval> | undefined;
    const stopSubagentPoll = () => {
      if (!subagentPoll) return;
      clearInterval(subagentPoll);
      subagentPoll = undefined;
    };
    // 侧栏读的是子会话 jsonl，不是正在写它的那个 runtime。不重读的话工具停在打开瞬间，工时也被收成 1 秒。
    let historyWatch: ReturnType<typeof setInterval> | undefined;
    let lastHistory = "";
    let historyPainting = false;
    const stopHistoryWatch = () => {
      if (!historyWatch) return;
      clearInterval(historyWatch);
      historyWatch = undefined;
    };
    const applyStoredTitle = (summary: ReturnType<typeof readPiJsonl>["summary"]) => {
      if (!summary?.title) return;
      const current = projector.getSnapshot().meta;
      if (
        !shouldApplyStoredSessionTitle({
          currentTitle: current.title,
          currentTitleSource: current.titleSource,
          storedTitle: summary.title,
          storedTitleNamed: summary.named,
        })
      ) {
        return;
      }
      emit(projector.setTitle(summary.title, "generated"));
    };
    const paintHistory = (content: string, settle: boolean) => {
      if (historyPainting) return;
      historyPainting = true;
      try {
        lastHistory = content;
        const parsed = readPiJsonl(content, { settle });
        emit(projector.reload(parsed.events));
        applyStoredTitle(parsed.summary);
      } finally {
        historyPainting = false;
      }
    };
    const startHistoryWatch = () => {
      if (historyWatch || !hasLiveSubagent(meta.sessionId)) return;
      historyWatch = setInterval(() => {
        void (async () => {
          if (historyPainting || pi.isStreaming) return;
          const live = hasLiveSubagent(meta.sessionId);
          const content = await readFile(meta.sessionFile, "utf8").catch(() => "");
          if (!live) {
            stopHistoryWatch();
            if (content) paintHistory(content, true);
            return;
          }
          if (!content || content === lastHistory) return;
          paintHistory(content, false);
        })();
      }, 1000);
    };
    const unsubscribeLiveSubagents = subscribeLiveSubagents(() => {
      void publishSubagents();
    });
    const unsubscribeProcesses =
      pi.subscribeManagedProcesses?.((works) => {
        emit(projector.replaceManagedProcesses(works));
      }) ?? (() => undefined);
    const unsubscribePersisted =
      pi.notePersistedMessage?.((notice) => {
        if (notice.role !== "assistant") return;
        emit(projector.bindPersistedEntry(notice.entryId));
      }) ?? (() => undefined);
    const unsubscribe = pi.subscribe((event: PiHostEvent) => {
      if (this.options.redirectPlannotatorToEmbeddedBrowser) {
        notePlannotatorBrowserSession(meta.sessionId);
      }
      try {
        if (event.type === "extension_ui_request") {
          handleUi(event);
          return;
        }
        if (event.type === "message_start" && event.message.role === "user") {
          const text = textOfMessageContent(event.message.content);
          // 审查决定是插件 sendUserMessage。对上原文才结束「工作中」，用户自己的消息不收口。
          if (text && pi.takeMatchingPlanDecision?.(text)) {
            emit(projector.finishOpenPlanReview(event.at));
          }
        }
        emit(projector.apply(event));
        // 停止之后 Pi 仍可能把重试的下一跳发出来。再 abort 一次，别让它接着跑。
        if (
          projector.wantsStop() &&
          (event.type === "agent_start" || event.type === "auto_retry_start")
        ) {
          abortInflightNetwork();
          void pi.abort();
        }
        const usageWhen = contextUsagePublish(event);
        if (usageWhen === "now") publishContextNow();
        else if (usageWhen === "soon") publishContextSoon();
        scheduleSubagents();
        // picode_subagent 在工具里跑完才返回，这段时间父会话没有新事件，目录不会刷新。
        if (event.type === "agent_start" && !subagentPoll) {
          subagentPoll = setInterval(() => {
            void publishSubagents();
          }, 1000);
        }
        const turnDone =
          event.type === "agent_settled" || (event.type === "agent_end" && !event.willRetry);
        // 手动压缩不发 agent_end。轮次里的自动压缩仍在 streaming，那时不能把队列提前 prompt。
        const compactDone = event.type === "compaction_end" && !pi.isStreaming;
        // 用户消息落地就总结。等 agent_end 的话，这一轮被关掉就永远不会再跑。
        if (shouldAutoSummarizeTitle(event)) {
          const snapshot = projector.getSnapshot();
          scheduleLiveSessionTitleSummary({
            sessionId: meta.sessionId,
            parentSessionId: meta.parentSessionId,
            titleSource: snapshot.meta.titleSource,
            sessionName: pi.sessionName,
            rows: snapshot.rows.window,
            fallbackProvider: snapshot.config.provider,
            fallbackModel: snapshot.config.model,
            stillEligible: () => {
              const latest = projector.getSnapshot();
              return latest.meta.titleSource !== "custom" && !pi.sessionName?.trim();
            },
            commit: (title) => {
              pi.setSessionName?.(title);
              emit(projector.setTitle(title, "generated"));
            },
          });
        }
        if (turnDone || compactDone) {
          if (turnDone) {
            stopSubagentPoll();
            void publishSubagents();
          }
          // 上一轮的 agent_end 可能先于 isStreaming 落下。这时 prompt 会抛
          // "already processing"，没人接的 rejection 会把 agent 进程打退出。
          if (pi.isStreaming || pi.isCompacting || pi.isIdle === false) return;
          void bridge
            .drainNext()
            .then((drained) => {
              if (drained) projector.replaceQueue(queue.snapshot());
            })
            .catch((error: unknown) => {
              console.error("pi-host queue drain failed", error);
            });
        }
      } catch (error) {
        console.error("pi-host event apply failed", event.type, error);
      }
    });
    let summarizingBranch = false;
    void pi.bindUi?.(createHostExtensionUi(ui, handleUi));
    if (pi.currentModel) {
      projector.setConfig({
        provider: pi.currentModel.providerId,
        model: pi.currentModel.modelId,
        thought: "medium",
        thoughtLevels: ["off", "minimal", "low", "medium", "high"],
      });
    }
    publishContext();
    let disposing: Promise<void> | undefined;
    return {
      sessionId: meta.sessionId,
      identity: meta.identity,
      workspacePath: meta.workspacePath,
      cwd: meta.cwd,
      sessionFile: meta.sessionFile,
      parentSessionId: meta.parentSessionId,
      workId: meta.workId,
      projector,
      queue,
      ui,
      bridge,
      viaRegistry: meta.viaRegistry,
      listModels: () => pi.listModels?.() ?? (pi.currentModel ? [pi.currentModel] : []),
      listSkills: () => pi.listSkills?.() ?? [],
      listSlashCommands: () => pi.listSlashCommands?.() ?? [],
      get isIdle() {
        return pi.isIdle ?? !pi.isStreaming;
      },
      get hasResidencyBlockingWork() {
        const snapshot = projector.getSnapshot();
        return piHostBlocksResidency({
          pi,
          phase: snapshot.control.phase,
          activeWorkCount: snapshot.control.activeWorks.length,
          queuedCount: queue.snapshot().items.length,
          branchSummary: summarizingBranch || projector.isBranchSummaryRunning(),
          backgroundActive: snapshot.backgroundWorks.some(
            (work) => work.status === "running" || work.status === "resultPending",
          ),
          pendingInteraction: snapshot.pendingInteractions.length > 0,
          runningSubagents: snapshot.subagents?.running.length ?? 0,
        });
      },
      prompt: (text) => pi.prompt(text),
      waitTurn: () => pi.waitTurn?.() ?? Promise.resolve(),
      abort: async () => {
        if (summarizingBranch) {
          pi.abortBranchSummary?.();
          return;
        }
        projector.markAborted();
        abortInflightNetwork();
        await pi.abort();
      },
      continueAfterError: () => {
        if (!pi.continueAfterError) return Promise.reject(new Error("continue unsupported"));
        return pi.continueAfterError();
      },
      cancelManagedProcess: async (workId) => {
        const id = workId.startsWith("pi-process:") ? workId.slice("pi-process:".length) : "";
        if (id) return (await pi.killManagedProcess?.(id)) ? "killed" : "missing";
        // 子会话的 workId 就是子会话 id。停不到就交给注册表里的子会话，不要回落去停父会话。
        if (abortLiveSubagent(workId)) {
          cancelledSubagents.add(workId);
          void publishSubagents();
          return "killed";
        }
        return "unrelated";
      },
      setRunningSubagentModel: (input) =>
        setLiveSubagentModel(input.childSessionId, {
          provider: input.provider,
          model: input.model,
          thought: input.thought,
        }),
      readManagedProcessOutput: (workId) =>
        pi.readManagedProcessOutput?.(workId) ?? Promise.resolve({ kind: "unavailable", workId }),
      compact: () => pi.compact(),
      setModel: async (provider, modelId, thought) => {
        await applyModel({ providerId: provider, modelId, thought });
        publishContext();
      },
      setThinkingLevel: (level) => {
        projector.setConfig({ thought: level });
        pi.setThinkingLevel?.(mapThought(level));
      },
      setSessionName: (name) => {
        pi.setSessionName?.(name);
      },
      publishCustomTitle: (title) => {
        emit(projector.setTitle(title, "custom"));
        pi.setSessionName?.(title);
      },
      branchFrom: pi.branchFrom,
      noteBranchSummary: (active) => {
        emit(projector.noteBranchSummary(active));
      },
      resumeAt: (request) =>
        runSessionResume({
          pi,
          request,
          reload: (events) => {
            emit(projector.reload(events));
          },
          setSummarizing: (active) => {
            summarizingBranch = active;
            emit(projector.noteBranchSummary(active));
          },
          releaseStop: () => {
            projector.releaseStop();
          },
          publishContext,
        }),
      captureAbandonedBranch: (request) => pi.captureAbandonedBranch?.(request),
      summarizeAbandoned: (captured, request) => {
        summarizingBranch = true;
        emit(projector.noteBranchSummary(true));
        return (async () => {
          let summaryText = "";
          try {
            const result = await pi.summarizeAbandonedBranch?.(captured, {
              ...(request.customInstructions
                ? { customInstructions: request.customInstructions }
                : {}),
              ...(request.label ? { label: request.label } : {}),
            });
            if (!result || result.cancelled) return;
            summaryText = result.summary?.trim() ?? "";
          } catch (error) {
            console.error("pi-host branch summary failed", error);
          } finally {
            summarizingBranch = false;
            // 先撤掉「正在总结」。这一行的删除会裁掉它后面的内容，摘要得等它撤完再补。
            emit(projector.noteBranchSummary(false));
          }
          if (!summaryText) return;
          if (pi.contextEvents) emit(projector.reload(pi.contextEvents()));
          const alreadyShown = projector
            .getSnapshot()
            .rows.window.some(
              (row) =>
                row.kind === "timelineMarker" &&
                row.marker.type === "branchSummary" &&
                row.marker.summary === summaryText,
            );
          if (!alreadyShown) emit(projector.appendBranchSummary(summaryText));
        })();
      },
      readSessionTree: () => pi.readTree?.() ?? [],
      labelSessionEntry: (entryId, label) => {
        assertBranchSummaryIdle(projector);
        pi.labelEntry?.(entryId, label);
        return pi.readTree?.() ?? [];
      },
      deleteSessionBranch: (entryId) => {
        assertBranchSummaryIdle(projector);
        if (pi.isCompacting || pi.isStreaming) {
          throw Object.assign(new Error("Wait for the current response to finish"), {
            reasonCode: "guard.sessionTreeBusy",
          });
        }
        if (!pi.deleteBranch) {
          throw Object.assign(new Error("Session tree is unavailable"), {
            reasonCode: "fault.command.sessionTreeUnsupported",
          });
        }
        pi.deleteBranch(entryId);
        return pi.readTree?.() ?? [];
      },
      navigateTree: async (targetId, options) => {
        assertBranchSummaryIdle(projector);
        let entryId = targetId;
        // 冷恢复的行 id 是 Pi entry。实时行 id 是 row:N，得用原文对上树节点。
        if (pi.hasEntry && !pi.hasEntry(targetId)) {
          const row = projector
            .getSnapshot()
            .rows.window.find((item) => item.entityId === targetId);
          const text = row && "text" in row && typeof row.text === "string" ? row.text : "";
          const role =
            row?.kind === "userInput"
              ? "user"
              : row?.kind === "assistantText"
                ? "assistant"
                : undefined;
          // 实时行的 entityId 是 message.id，不是树节点 id。先按消息 id 对上 entry，对不上再用原文。
          entryId =
            pi.resolveEntry?.(targetId, {
              ...(text ? { text } : {}),
              ...(role ? { role } : {}),
            }) ||
            (text && role !== "assistant" && pi.matchUserEntry?.(text)) ||
            "";
          if (!entryId) throw new Error(`Entry ${targetId} not found`);
        }
        if (pi.isStreaming) await pi.abort();
        const summarize = options?.summarize === true;
        if (summarize) {
          projector.releaseStop();
          summarizingBranch = true;
          emit(projector.noteBranchSummary(true));
        }
        try {
          const result = await pi.navigateTree?.(
            entryId,
            summarize
              ? {
                  summarize: true,
                  ...(options?.customInstructions
                    ? { customInstructions: options.customInstructions }
                    : {}),
                }
              : undefined,
          );
          if (result?.cancelled) return { cancelled: true };
          // 总结写在新叶子上。只截断旧行会把摘要丢掉。
          if (summarize && pi.contextEvents) emit(projector.reload(pi.contextEvents()));
          else emit(projector.truncateFrom(targetId));
          // 先收起「正在总结」，再补正文。反过来会把刚补上的摘要一起裁掉。
          if (summarize) emit(projector.noteBranchSummary(false));
          const summaryText = result?.summaryEntry?.summary?.trim() ?? "";
          const alreadyShown = projector
            .getSnapshot()
            .rows.window.some(
              (row) =>
                row.kind === "timelineMarker" &&
                row.marker.type === "branchSummary" &&
                row.marker.summary === summaryText,
            );
          if (summaryText && !alreadyShown) emit(projector.appendBranchSummary(summaryText));
          return { cancelled: false };
        } finally {
          if (summarize) {
            summarizingBranch = false;
            emit(projector.noteBranchSummary(false));
          }
        }
      },
      setFeedback: (entityId, feedback) => {
        emit(projector.setFeedback(entityId, feedback));
      },
      markTurnFilesReverted: (turnId) => {
        emit(projector.markTurnFilesReverted(turnId));
      },
      publishUi: () => {
        const snap = ui.snapshot();
        emit(projector.replaceInteractions(snap.pending));
        emit(projector.replaceWidgets(snap.widgets));
        emit(projector.replaceStatuses(snap.statuses));
      },
      sessionAllows: sessionAllowed,
      applyAccessFrom: (source) => {
        for (const name of source.sessionAllows) sessionAllowed.add(name);
        const mode = source.projector.getSnapshot().config.mode;
        if (mode) setCollaborationMode(mode);
      },
      setCollaborationMode,
      requestConfirm: async (toolName, reason, args) => {
        if (sessionAllowed.has(toolName)) return true;
        const id = `perm:${randomUUID()}`;
        const waiting = ui.wait(id);
        const next = ui.askPermission({
          id,
          toolName,
          summary: reason,
          detail: args,
        });
        emit(projector.replaceInteractions(next.pending));
        const response = await waiting;
        emit(projector.replaceInteractions(ui.snapshot().pending));
        const allowed = permissionAllowed(response);
        if (allowed && "value" in response && response.value === "allowAlways") {
          sessionAllowed.add(toolName);
        }
        return allowed;
      },
      dispose: () => {
        if (disposing) return disposing;
        if (contextTimer) clearTimeout(contextTimer);
        if (subagentTimer) clearTimeout(subagentTimer);
        stopHistoryWatch();
        stopSubagentPoll();
        unsubscribeLiveSubagents();
        unsubscribeProcesses();
        unsubscribePersisted();
        unsubscribe();
        unregisterBrowser();
        // 常驻回收只关 runtime，不删 jsonl。注册表必须同步摘掉：留着已关掉的实例，下次 create 会直接复用它，不再读文件。
        // MCP 子进程在 pi.dispose() 里异步关，不能挡住这次摘除。
        this.sessions.delete(meta.sessionId);
        this.toolChecks.delete(meta.sessionId);
        this.children.delete(meta.sessionId);
        for (const ids of this.children.values()) ids.delete(meta.sessionId);
        disposing = Promise.resolve(pi.dispose());
        return disposing;
      },
      hydrateHistory: (content) => {
        const live = hasLiveSubagent(meta.sessionId);
        lastHistory = content;
        const parsed = readPiJsonl(content, { settle: !live });
        emit(projector.replay(parsed.events));
        applyStoredTitle(parsed.summary);
        void publishSubagents();
        if (live) startHistoryWatch();
      },
      reloadHistory: (content) => {
        const live = hasLiveSubagent(meta.sessionId);
        lastHistory = content;
        const parsed = readPiJsonl(content, { settle: !live });
        emit(projector.reload(parsed.events));
        applyStoredTitle(parsed.summary);
        if (live) startHistoryWatch();
      },
      onDeltas: (listener) => {
        deltaListeners.add(listener);
        if (pendingDeltas.length > 0) {
          listener(pendingDeltas.splice(0, pendingDeltas.length));
        }
        return () => {
          deltaListeners.delete(listener);
        };
      },
      onNotify: (listener) => {
        notifyListeners.add(listener);
        return () => {
          notifyListeners.delete(listener);
        };
      },
    };
  }
}
