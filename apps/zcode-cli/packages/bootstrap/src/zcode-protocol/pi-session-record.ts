import { readFile } from "node:fs/promises";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import { summarizePiJsonl, type HostedSession, type HostSessionRegistry } from "@zcode/pi-host";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import { createPiHostedApp } from "../app/pi-hosted-app.js";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";
import { connectZCodeMcp } from "./pi-capabilities.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

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
      await store.createSession({
        id: sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        ...(workspace.workspaceIdentity
          ? { workspaceID: workspace.workspaceIdentity as WorkspaceId }
          : {}),
        slug: sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "session",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: compact ? compact.slice(0, 60) : "Untitled session",
        titleSource: "first_input",
        version: context.deps.version ?? "0.0.0",
        permission: { mode: "build" },
        traceID: createRootTraceContext({ sessionId }).traceId,
      });
    },
  });
  const summary = summarizePiJsonl(await readFile(hosted.sessionFile, "utf8").catch(() => ""));
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
  return record;
}

export async function createPiSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: {
    workspace: ZCodeWorkspaceRef;
    sessionId?: string;
    parentSessionId?: string;
    mcpServers?: ZCodeProtocolMcpServer[];
  },
): Promise<ZCodeProtocolSessionRecord> {
  const registry = context.piHost;
  if (!registry) throw new Error("pi-host registry missing");
  await connectZCodeMcp(context, {
    workspacePath: params.workspace.workspacePath,
    mcpServers: params.mcpServers,
  });
  const hosted = await registry.create({
    workspaceIdentity: params.workspace.workspaceIdentity,
    workspacePath: params.workspace.workspacePath,
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
  }));
}
