import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationDelta, DeliveryProfileName } from "@zcode/shared/zcode-protocol-v4";
import { CommandBridge, type SubmissionModel } from "./command-bridge.js";
import { createHostExtensionUi } from "./extension-ui-bridge.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { HostQueue } from "./host-queue.js";
import { workspaceKey } from "./identity.js";
import { readPiJsonl } from "./jsonl-history.js";
import {
  listPiSubagentChildren,
  piSubagentRevision,
  type PiSubagentChild,
} from "./pi-subagent-index.js";
import { mapThought } from "./model-delegate.js";
import { PiToV4Projector } from "./projector.js";
import type { ToolPermissionCheck } from "./permission-gate.js";
import type {
  CreatePiSession,
  PiExtensionUiResponse,
  PiHostEvent,
  PiSessionPort,
  PiSkillView,
  PiSlashCommandView,
} from "./types.js";

export interface HostedSession {
  readonly sessionId: string;
  readonly identity: string;
  readonly workspacePath: string;
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
  prompt(text: string): Promise<boolean>;
  waitTurn(): Promise<void>;
  abort(): Promise<void>;
  cancelManagedProcess(workId: string): Promise<"killed" | "missing" | "unrelated">;
  readManagedProcessOutput(workId: string): Promise<import("@zcode/shared").BackgroundBashOutputResult>;
  compact(): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  branchFrom?(entryId: string): { sessionId: string; sessionFile: string };
  reloadHistory(content: string): void;
  setModel(provider: string, modelId: string, thought?: string): Promise<void>;
  setThinkingLevel(level: string): void;
  setFeedback(entityId: string, feedback: "like" | "dislike" | null): void;
  markTurnFilesReverted(turnId: string): void;
  requestConfirm(toolName: string, reason: string, args?: unknown): Promise<boolean>;
  publishUi(): void;
  dispose(): void;
  hydrateHistory(content: string): void;
  onDeltas(listener: (deltas: ConversationDelta[]) => void): () => void;
  onNotify(listener: (message: string, notifyType: "info" | "warning" | "error") => void): () => void;
}

export type PiStoredSummary = {
  sessionId: string;
  sessionFile: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  lastAssistantPreview?: string;
};

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
  return response.value !== "deny" && response.value !== "no" && response.value !== "";
}

export class HostSessionRegistry {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly children = new Map<string, Set<string>>();
  private readonly toolChecks = new Map<string, ToolPermissionCheck>();

  constructor(private readonly options: RegistryOptions) {}

  get(sessionId: string): HostedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async create(input: {
    workspaceIdentity?: string | null;
    workspacePath: string;
    sessionId?: string;
    parentSessionId?: string;
    viaRegistry?: boolean;
  }): Promise<HostedSession> {
    if (input.sessionId) {
      const existing = this.sessions.get(input.sessionId);
      if (existing) return existing;
      const stored = await this.find(input.sessionId);
      if (stored) {
        return this.openFile({
          sessionId: stored.sessionId,
          identity: stored.identity,
          workspacePath: stored.workspacePath,
          sessionFile: stored.sessionFile,
          parentSessionId: input.parentSessionId,
          viaRegistry: input.viaRegistry,
        });
      }
    }
    const identity = workspaceKey(input.workspaceIdentity, input.workspacePath);
    const sessionId = input.sessionId ?? randomUUID();
    const dir = nativeSessionDir(identity, nativeSessionsRoot(this.options.nativeSessionsRoot));
    await mkdir(dir, { recursive: true });
    return this.openFile({
      sessionId,
      identity,
      workspacePath: input.workspacePath,
      sessionFile: join(dir, piSessionFileName(sessionId)),
      parentSessionId: input.parentSessionId,
      viaRegistry: input.viaRegistry,
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
    });
  }

  async fork(parentId: string, entryId: string): Promise<HostedSession> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    if (parent.branchFrom) {
      const branched = parent.branchFrom(entryId);
      return this.openFile({
        sessionId: branched.sessionId,
        identity: parent.identity,
        workspacePath: parent.workspacePath,
        sessionFile: branched.sessionFile,
        parentSessionId: parentId,
        viaRegistry: true,
      });
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
    return hosted;
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
      hosted.dispose();
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
    sessionFile: string;
    parentSessionId?: string;
    viaRegistry?: boolean;
  }): Promise<HostedSession> {
    const live = this.sessions.get(input.sessionId);
    if (live) return live;
    const pi = await this.options.createSession({
      sessionId: input.sessionId,
      cwd: input.workspacePath,
      sessionFile: input.sessionFile,
      parentSessionId: input.parentSessionId,
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
    const notifyListeners = new Set<(message: string, notifyType: "info" | "warning" | "error") => void>();
    const pendingDeltas: ConversationDelta[] = [];
    const sessionAllowed = new Set<string>();
    const emit = (deltas: ConversationDelta[]) => {
      if (deltas.length === 0) return;
      if (deltaListeners.size === 0) {
        pendingDeltas.push(...deltas);
        return;
      }
      for (const listener of deltaListeners) listener(deltas);
    };
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
    const bridge = new CommandBridge(pi, queue, applyModel);
    const publishContext = () => {
      const usage = pi.contextUsage?.();
      if (!usage) return;
      emit(projector.setContextUsage(usage.used, usage.max));
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
    let subagentTimer: ReturnType<typeof setTimeout> | undefined;
    const publishSubagents = async () => {
      if (!meta.sessionFile) return;
      const children = await listPiSubagentChildren({
        parentSessionFile: meta.sessionFile,
        parentSessionId: meta.sessionId,
      }).catch(() => [] as PiSubagentChild[]);
      const running = children.filter(
        (child) => child.status === "running" || child.status === "waiting" || child.status === "blocked",
      );
      const next = {
        revision: piSubagentRevision(children),
        childSessionIds: children.map((child) => child.childSessionId),
        running: running.map((child) => ({
          childSessionId: child.childSessionId,
          subagentType: child.subagentType,
          title: child.title,
          status: child.status as "running" | "waiting" | "blocked",
          ...(child.summary ? { summary: child.summary } : {}),
          ...(child.startedAt ? { startedAt: child.startedAt } : {}),
        })),
        endedTotal: children.length - running.length,
      };
      const key = JSON.stringify(next);
      if (key === subagentKey) return;
      subagentKey = key;
      emit(projector.replaceSubagents(next));
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
    const unsubscribeProcesses =
      pi.subscribeManagedProcesses?.((works) => {
        emit(projector.replaceManagedProcesses(works));
      }) ?? (() => undefined);
    const unsubscribe = pi.subscribe((event: PiHostEvent) => {
      try {
        if (event.type === "extension_ui_request") {
          handleUi(event);
          return;
        }
        emit(projector.apply(event));
        if (
          event.type === "compaction_end" ||
          (event.type === "agent_end" && !event.willRetry)
        ) {
          publishContext();
        }
        scheduleSubagents();
        // zcode_subagent 在工具里跑完才返回，这段时间父会话没有新事件，目录不会刷新。
        if (event.type === "agent_start" && !subagentPoll) {
          subagentPoll = setInterval(() => {
            void publishSubagents();
          }, 1000);
        }
        if (event.type === "agent_settled" || (event.type === "agent_end" && !event.willRetry)) {
          stopSubagentPoll();
          void publishSubagents();
          void bridge.drainNext().then((drained) => {
            if (drained) emit(projector.replaceQueue(queue.snapshot()));
          });
        }
      } catch (error) {
        console.error("pi-host event apply failed", event.type, error);
      }
    });
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
    return {
      sessionId: meta.sessionId,
      identity: meta.identity,
      workspacePath: meta.workspacePath,
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
      prompt: (text) => pi.prompt(text),
      waitTurn: () => pi.waitTurn?.() ?? Promise.resolve(),
      abort: async () => {
        projector.markAborted();
        await pi.abort();
      },
      cancelManagedProcess: async (workId) => {
        const id = workId.startsWith("pi-process:") ? workId.slice("pi-process:".length) : "";
        if (!id) return "unrelated";
        return (await pi.killManagedProcess?.(id)) ? "killed" : "missing";
      },
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
      branchFrom: pi.branchFrom,
      navigateTree: async (targetId) => {
        let entryId = targetId;
        // 冷恢复的行 id 是 Pi entry。实时行 id 是 row:N，得用原文对上树节点。
        if (pi.hasEntry && !pi.hasEntry(targetId)) {
          const row = projector.getSnapshot().rows.window.find((item) => item.entityId === targetId);
          const text = row && "text" in row && typeof row.text === "string" ? row.text : "";
          entryId = (text && pi.matchUserEntry?.(text)) || "";
          if (!entryId) throw new Error(`Entry ${targetId} not found`);
        }
        if (pi.isStreaming) await pi.abort();
        await pi.navigateTree?.(entryId);
        emit(projector.truncateFrom(targetId));
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
        if (subagentTimer) clearTimeout(subagentTimer);
        stopSubagentPoll();
        unsubscribeProcesses();
        unsubscribe();
        pi.dispose();
      },
      hydrateHistory: (content) => {
        const parsed = readPiJsonl(content);
        for (const event of parsed.events) emit(projector.apply(event));
        if (parsed.summary?.title) emit(projector.setTitle(parsed.summary.title, "generated"));
        void publishSubagents();
      },
      reloadHistory: (content) => {
        const parsed = readPiJsonl(content);
        emit(projector.reload(parsed.events));
        if (parsed.summary?.title) emit(projector.setTitle(parsed.summary.title, "generated"));
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
