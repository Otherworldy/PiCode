import { mapMessageWithParts } from "./message-mapper.js";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  type ZCodeSessionStateSnapshot,
} from "@picode/shared";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";
import { sessionMode, sessionSelection, sessionThoughtLevels } from "./session-config.js";

/** 旧 wire 的展示映射：读取 Pi 投影事实，不构造 Core SessionProjection / runtime。 */
export function hostedProtocolSnapshot(
  record: ZCodeProtocolSessionRecord,
  messages: import("@picode/contracts").MessageWithParts[] = [],
): ZCodeSessionStateSnapshot {
  const hosted = record.hosted;
  if (!hosted) throw new Error("Hosted session required");
  const view = hosted.projector.getSnapshot();
  const busy =
    !hosted.isIdle || view.control.phase === "running" || view.control.phase === "prewarming";
  const status = view.pendingInteractions.length
    ? "waiting"
    : busy
      ? "running"
      : view.control.phase === "error"
        ? "error"
        : view.control.phase === "draft"
          ? "idle"
          : "completed";
  const mode = sessionMode(record);
  const model = sessionSelection(record);
  const usage = view.usage.contextWindow;
  const levels = sessionThoughtLevels(record);
  const turn = [...view.rows.window].reverse().find((row) => row.kind === "turnHeader");
  return {
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: hosted.sessionId,
      workspace: record.workspace,
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
      traceId: record.traceContext.traceId,
      sessionKind: record.taskType ?? "interactive",
      title: view.meta.title,
      titleSource: view.meta.titleSource,
      mode,
      status,
      ...(model ? { model } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    projection: {
      sessionId: hosted.sessionId,
      status,
      mode,
      turnCount: view.usage.cumulative.turns,
      totalTokenCount: view.usage.cumulative.inputTokens + view.usage.cumulative.outputTokens,
      contextUsed: usage?.usedTokens ?? 0,
      contextWindow: usage?.maxTokens ?? 0,
      ...(busy && turn?.kind === "turnHeader" ? { currentTurnId: turn.turnId } : {}),
      pendingPermissions: [],
      activeToolCalls: view.rows.window.flatMap((row) =>
        row.kind === "toolCall" && row.status === "running"
          ? [{ toolCallId: row.toolCallId, toolName: row.toolName, status: "running" as const }]
          : [],
      ),
      backgroundJobs: view.backgroundWorks.map((work) => ({ ...work })),
    },
    runtime: {
      eventSeq: view.seq,
      stateRevision: record.stateRevision,
      ...(record.deliveryKind ? { deliveryKind: record.deliveryKind } : {}),
      ...(busy && turn?.kind === "turnHeader" ? { activeTurnId: turn.turnId } : {}),
      ...(usage && usage.maxTokens > 0
        ? {
            contextUsage: {
              used: usage.usedTokens,
              size: usage.maxTokens,
              ...(usage.cache ? { cache: usage.cache } : {}),
              ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
            },
          }
        : {}),
      pendingRequestIds: view.pendingInteractions.map((item) => item.interactionId),
    },
    settings: {
      model: {
        ...(model ? { current: model, lastUsed: model } : {}),
        available: hosted.listModels().map((item) => ({
          // 目录项含 name；整对象透传会被严格 schema 拒绝，索引缺行后会话无法删除。
          ref: { providerId: item.providerId, modelId: item.modelId },
          label: item.modelId,
          providerLabel: item.providerId,
          properties: {
            inputFormat: {
              supportsText: true,
              supportsImage: false,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf: false,
            },
            outputFormat: { supportsText: true },
          },
        })),
      },
      mode: { current: mode },
      permission: { mode },
      thoughtLevel: {
        enabled: levels.length > 0,
        ...(view.config.thought ? { current: view.config.thought } : {}),
        available: levels.map((level) => ({ value: level, label: level })),
      },
    },
    messages: messages.map(mapMessageWithParts),
    todos: [],
    todoGroups: [],
    slashCommands: hosted.listSlashCommands(),
  };
}
