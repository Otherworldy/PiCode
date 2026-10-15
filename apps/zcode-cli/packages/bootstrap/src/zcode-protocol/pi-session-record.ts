import { readFile } from "node:fs/promises";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  readPiJsonl,
  summarizePiJsonl,
  type HostedSession,
  type HostSessionRegistry,
  type PiStoredSession,
} from "@zcode/pi-host";
import { isBareSlashCommandTitle, type ZCodeWorkspaceRef } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import { createPiHostedApp } from "../app/pi-hosted-app.js";
import {
  permissionWithCollaborationMode,
  storedCollaborationMode,
} from "./hosted-collaboration-mode.js";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

/** publisher 还是空的时，按 jsonl 重画。生成中不重画，避免冲掉还没落盘的这一轮。 */
export async function restoreHostedProjection(hosted: HostedSession): Promise<void> {
  if (!hosted.isIdle) return;
  const content = await readFile(hosted.sessionFile, "utf8").catch(() => "");
  if (readPiJsonl(content).events.length === 0) return;
  hosted.reloadHistory(content);
}

export async function bindHostedSession(
  context: ZCodeProtocolAgentServerContext,
  hosted: HostedSession,
  workspace: ZCodeWorkspaceRef,
): Promise<ZCodeProtocolSessionRecord> {
  const sessionId = hosted.sessionId as SessionId;
  const app = createPiHostedApp(hosted, {
    abortWork: (workId) => {
      if (!context.piHost) return Promise.resolve(false);
      return context.piHost.abort(workId);
    },
    persistSession: async (title) => {
      const store = context.deps.sessionStore;
      if (!store) return;
      const compact = title.trim().replace(/\s+/g, " ");
      // 计划模式的第一条 admission 是 /plannotator-plan-mode。写进 first_input 后，
      // 侧栏会一直显示这条命令，直到点开会话才按 jsonl 重算。
      const visibleTitle = compact && !isBareSlashCommandTitle(compact) ? compact.slice(0, 60) : "";
      const existing = await store.getSession(sessionId);
      await store.createSession({
        id: sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        ...(workspace.workspaceIdentity
          ? { workspaceID: workspace.workspaceIdentity as WorkspaceId }
          : {}),
        slug: sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "session",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: visibleTitle || "Untitled session",
        titleSource: "first_input",
        version: context.deps.version ?? "0.0.0",
        // 冲突更新会整份换掉 permission。写死 build 会把已经保存的完全访问抹掉，
        // 进程重启后工具闸回到 build，输入框却还显示完全访问。
        permission: permissionWithCollaborationMode(
          existing?.permission,
          hosted.projector.getSnapshot().config.mode,
        ),
        traceID: createRootTraceContext({ sessionId }).traceId,
      });
    },
    onCollaborationMode: (mode) => {
      void persistHostedCollaborationMode(context, sessionId, mode);
    },
  });
  const summary = summarizePiJsonl(await readFile(hosted.sessionFile, "utf8").catch(() => ""));
  // jsonl 已有内容会标成 immediate，admission 就不再补 session 行。
  // session_input 外键要求这行先在，否则打开旧会话后的第一条发送直接 FOREIGN KEY constraint failed。
  if (summary && context.deps.sessionStore) {
    const existing = await context.deps.sessionStore.getSession(sessionId);
    if (!existing) await app.runtime.ensureSessionPersistedForExternalActivity(summary.title);
    else if (
      isBareSlashCommandTitle(existing.title) &&
      summary.title &&
      !isBareSlashCommandTitle(summary.title)
    ) {
      // 旧行还停在命令标题。打开时用 jsonl 的真实标题换掉，避免下次回源又写回去。
      await context.deps.sessionStore.updateSession({
        id: sessionId,
        title: summary.title.slice(0, 60),
        titleSource: "generated",
        expectedTitleSources: ["first_input", "default", "generated"],
      });
    }
  }
  const record: ZCodeProtocolSessionRecord = {
    app,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "legacy",
    createdAt: summary?.createdAt ?? Date.now(),
    eventStore: context.deps.createSessionEventStore?.(sessionId) ?? createInMemorySessionEventStore(),
    ...(hosted.parentSessionId
      ? { parentSessionId: hosted.parentSessionId as SessionId }
      : {}),
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: createRootTraceContext({ sessionId }),
    updatedAt: summary?.lastActivityAt ?? Date.now(),
    workspace,
    persistence: summary ? "immediate" : "deferred",
  };
  // 必须先恢复模式再入注册表。命令进来时若还是 build，完全访问下的工具会先弹窗。
  await restoreHostedCollaborationMode(context, hosted);
  // 历史 delta 在订阅时一次性吐出。必须先入注册表，sessions-index 才能按 workspace 挂上侧栏。
  context.sessions.set(sessionId, record);
  const unsubscribeDeltas = hosted.onDeltas((deltas) => {
    context.v4Gateway?.ingestPiDeltas(sessionId, deltas);
  });
  record.unsubscribe = () => {
    unsubscribeDeltas();
    hosted.dispose();
  };
  const snapshot = hosted.projector.getSnapshot();
  const title = snapshot.meta.title.trim() || summary?.title || "";
  // 分支文件已经在磁盘上。增量如果被 draft 过滤掉，当前列表要到重启重扫才看得到。
  if (title) {
    record.persistence = "immediate";
    context.v4Gateway?.revealStoredSession(workspace.workspaceKey, {
      sessionId,
      workspaceId: workspace.workspaceKey,
      ...(hosted.parentSessionId ? { parentSessionId: hosted.parentSessionId } : {}),
      title,
      titleSource: snapshot.meta.titleSource === "default" ? "generated" : snapshot.meta.titleSource,
      phase: snapshot.control.phase === "draft" ? "completedSuccess" : snapshot.control.phase,
      sessionEnded: snapshot.control.sessionEnded,
      hasBackgroundWork: snapshot.backgroundWorks.some((work) => work.status === "running"),
      lastActivityAt: summary?.lastActivityAt ?? Date.now(),
      createdAt: summary?.createdAt ?? record.createdAt,
      ...(summary?.lastAssistantPreview
        ? { lastAssistantPreview: summary.lastAssistantPreview }
        : {}),
      ...(summary?.cwd && summary.cwd !== workspace.workspacePath
        ? { workingDirectory: summary.cwd }
        : {}),
    });
  }
  return record;
}

/** 模式只活在内存里的话，进程退出后重建的会话会回到 build，完全访问仍会弹窗。 */
async function persistHostedCollaborationMode(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  mode: string,
): Promise<void> {
  const store = context.deps.sessionStore;
  const stored = storedCollaborationMode(mode);
  if (!store || !stored) return;
  try {
    const existing = await store.getSession(sessionId);
    if (!existing || existing.permission?.mode === stored) return;
    await store.updateSession({
      id: sessionId,
      permission: permissionWithCollaborationMode(existing.permission, stored),
    });
  } catch (error) {
    context.logger?.warn("pi-host collaboration mode was not persisted", {
      error: error instanceof Error ? error.message : String(error),
      mode: stored,
      sessionId,
    });
  }
}

async function restoreHostedCollaborationMode(
  context: ZCodeProtocolAgentServerContext,
  hosted: HostedSession,
): Promise<void> {
  const store = context.deps.sessionStore;
  if (!store) return;
  const existing = await store.getSession(hosted.sessionId as SessionId);
  const mode = storedCollaborationMode(existing?.permission?.mode);
  if (!mode || mode === hosted.projector.getSnapshot().config.mode) return;
  hosted.setCollaborationMode(mode);
}

export async function createPiSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: {
    workspace: ZCodeWorkspaceRef;
    sessionId?: string;
    parentSessionId?: string;
    mcpServers?: ZCodeProtocolMcpServer[];
    workingDirectory?: string;
    /** 冷恢复在 create 之前那次 find 的耗时，并进 open timing 的 readJsonlMs。 */
    openReadMs?: number;
    /** 冷恢复已经找到的 jsonl。传入后 create 不再 find。 */
    storedSession?: PiStoredSession;
  },
): Promise<ZCodeProtocolSessionRecord> {
  const registry = context.piHost;
  if (!registry) throw new Error("pi-host registry missing");
  const hosted = await registry.create({
    workspaceIdentity: params.workspace.workspaceIdentity,
    workspacePath: params.workspace.workspacePath,
    workingDirectory: params.workingDirectory,
    sessionId: params.sessionId ?? createSessionId(),
    parentSessionId: params.parentSessionId,
    ...(params.openReadMs !== undefined ? { openReadMs: params.openReadMs } : {}),
    ...(params.storedSession ? { storedSession: params.storedSession } : {}),
  });
  return bindHostedSession(context, hosted, params.workspace);
}

export async function listPiStoredSummaries(
  registry: HostSessionRegistry,
  workspaceId: string,
) {
  const listed = await registry.list(workspaceId);
  return listed.map((item) => ({
    sessionId: item.sessionId,
    workspaceId,
    title: item.title,
    titleSource: "generated" as const,
    phase: "completedSuccess" as const,
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: item.lastActivityAt,
    createdAt: item.createdAt,
    ...(item.lastAssistantPreview ? { lastAssistantPreview: item.lastAssistantPreview } : {}),
    ...(item.cwd && item.cwd !== workspaceId ? { workingDirectory: item.cwd } : {}),
  }));
}
