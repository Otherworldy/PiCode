import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import type { HostedSession, HostSessionRegistry } from "@zcode/pi-host";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import { createPiHostedApp } from "../app/pi-hosted-app.js";
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
  const unsubscribeDeltas = hosted.onDeltas((deltas) => {
    context.v4Gateway?.ingestPiDeltas(sessionId, deltas);
  });
  return {
    app,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "legacy",
    createdAt: Date.now(),
    eventStore: context.deps.createSessionEventStore?.(sessionId) ?? createInMemorySessionEventStore(),
    persistence: "deferred",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: createRootTraceContext({ sessionId }),
    unsubscribe: () => {
      unsubscribeDeltas();
      hosted.dispose();
    },
    updatedAt: Date.now(),
    workspace,
  };
}

export async function createPiSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: {
    workspace: ZCodeWorkspaceRef;
    sessionId?: string;
    parentSessionId?: string;
  },
): Promise<ZCodeProtocolSessionRecord> {
  const registry = context.piHost;
  if (!registry) throw new Error("pi-host registry missing");
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
  const now = Date.now();
  return listed.map((item) => ({
    sessionId: item.sessionId,
    workspaceId,
    title: "",
    phase: "draft" as const,
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: now,
    createdAt: now,
  }));
}
