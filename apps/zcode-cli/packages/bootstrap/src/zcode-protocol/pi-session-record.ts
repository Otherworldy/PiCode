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
} from "@zcode/pi-host";
import { isBareSlashCommandTitle, type ZCodeWorkspaceRef } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import { createPiHostedApp } from "../app/pi-hosted-app.js";
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
        permission: { mode: "build" },
        traceID: createRootTraceContext({ sessionId }).traceId,
      });
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

export async function createPiSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: {
    workspace: ZCodeWorkspaceRef;
    sessionId?: string;
    parentSessionId?: string;
    mcpServers?: ZCodeProtocolMcpServer[];
    workingDirectory?: string;
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
