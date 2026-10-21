import type {
  ConversationSnapshot,
  DeliveryProfileName,
  SessionActionAvailability,
} from "@zcode/shared/zcode-protocol-v4";

/** 空的会话累计量。快照初始化与 reload 归零共用，免得加字段时漏一处。 */
export function emptyCumulativeUsage(): ConversationSnapshot["usage"]["cumulative"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
  };
}

const ALLOWED = { allowed: true as const };
const denied = (reasonCode: string) => ({ allowed: false as const, reasonCode });

export function emptyAvailability(running: boolean): SessionActionAvailability {  return {
    fork: running ? denied("guard.sessionBusy") : ALLOWED,
    compact: running ? denied("guard.sessionBusy") : ALLOWED,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: ALLOWED,
    pauseGoal: denied("guard.capabilityUnsupported"),
    resumeGoal: denied("guard.capabilityUnsupported"),
  };
}

export function createEmptySnapshot(
  sessionId: string,
  logEpoch: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch,
    seq: 0,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: emptyAvailability(false),
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: emptyCumulativeUsage(),
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

export function nextProfileFlush(profile: DeliveryProfileName): number {
  return profile === "replayable" ? 150 : 30;
}
