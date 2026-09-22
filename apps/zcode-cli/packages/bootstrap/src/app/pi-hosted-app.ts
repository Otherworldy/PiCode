import type { HostedSession } from "@zcode/pi-host";
import { RewindStrategy, type CollaborationMode, type ModelSelection, type SessionId, type TurnId } from "@zcode/contracts";
import type { ZCodeApp, PromptInput, SendInputResult } from "./types.js";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

function textOf(input: PromptInput): string {
  return typeof input === "string" ? input : input.text;
}

export function createPiHostedApp(
  hosted: HostedSession,
  options: {
    abortWork?: (workId: string) => Promise<boolean>;
    persistSession?: (title: string) => Promise<void>;
  } = {},
): ZCodeApp {
  const sessionId = hosted.sessionId as SessionId;
  const dummyCompletion = (turnId: string) =>
    Promise.resolve({
      response: "",
      turnId: turnId as TurnId,
      traceId: "pi-host",
      events: [],
      projection: {},
    });

  const send = async (
    input: PromptInput,
    delivery: "startNow" | "queue" | "guide",
    commandId = `cmd:${Date.now()}`,
  ): Promise<SendInputResult> => {
    const streaming = hosted.projector.getSnapshot().control.phase === "running";
    const result = await hosted.bridge.admitSend({
      text: textOf(input),
      clientId: "v4",
      commandId,
      delivery,
      streaming,
    });
    hosted.projector.replaceQueue(hosted.queue.snapshot());
    if (result.kind === "queued") {
      return {
        kind: "queued",
        pendingInputId: result.queueItemId,
        queueLength: hosted.queue.snapshot().items.length,
        turnId: hosted.sessionId as TurnId,
      };
    }
    const turnId = hosted.sessionId as TurnId;
    return {
      kind: "started_turn",
      turnId,
      completion: hosted.waitTurn().then(() => dummyCompletion(turnId)) as SendInputResult extends {
        completion: infer C;
      }
        ? C
        : never,
    };
  };

  const runtime = {
    stopActiveForegroundExecution: () => {
      void hosted.abort();
      return { kind: "stopped" as const, foregroundExecutionId: hosted.sessionId };
    },
    acquireForegroundPromotionLease: () => ({ kind: "acquired" as const }),
    releaseForegroundPromotionLease: () => undefined,
    setCustomSessionTitle: async ({ title }: { title: string }) => {
      hosted.projector.setTitle(title, "custom");
    },
    getActiveTurnInfo: () =>
      hosted.projector.getSnapshot().control.phase === "running"
        ? { turnId: hosted.sessionId }
        : null,
    getSessionModelSelection: (): ModelSelection | undefined => {
      const config = hosted.projector.getSnapshot().config;
      if (!config.provider || !config.model) return undefined;
      return {
        providerId: config.provider,
        modelId: config.model,
        ...(config.thought ? { options: { reasoningLevel: config.thought } } : {}),
      };
    },
    emitModelSelected: async () => undefined,
    getPlanEnabled: () => false,
    rewindConversationToMessage: async (input: { targetMessageId: string }) => {
      await hosted.navigateTree(String(input.targetMessageId));
      return {
        keptMessageCount: 0,
        response: "",
        rewindId: `rewind:${input.targetMessageId}`,
        strategy: RewindStrategy.ActiveChain,
        targetMessageId: input.targetMessageId,
      };
    },
    previewWorkspaceFileRewind: async () => ({
      canApply: false,
      ignoredFiles: [],
      safeFiles: [],
      unsafeFiles: [],
    }),
    hasResidencyBlockingWork: () =>
      hosted.projector.getSnapshot().control.phase === "running" ||
      hosted.queue.snapshot().items.length > 0,
    getActiveForegroundExecutionId: () =>
      hosted.projector.getSnapshot().control.phase === "running" ? hosted.sessionId : undefined,
    ensureSessionPersistedForExternalActivity: async (title?: string) => {
      await options.persistSession?.(typeof title === "string" ? title : "");
    },
    setExecutionState: async (input?: { mode?: string; planEnabled?: boolean }) => {
      if (!input?.mode) return;
      hosted.projector.setConfig({ mode: input.mode });
      hosted.ui.autoConfirm = input.mode === "yolo";
    },
    getProjection: async () => ({
      id: sessionId,
      createdAt: new Date(),
      updatedAt: new Date(),
      mode: (hosted.projector.getSnapshot().config.mode as CollaborationMode) || "build",
      status: "idle" as const,
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      pendingPermissions: [],
      pendingSteerInputs: [],
      activeToolCalls: [],
      streamingToolLedger: [],
      backgroundTasks: [],
      targetCompletionVerifications: [],
      targetCompletionVerificationTimeline: [],
    }),
  };

  const app = {
    sessionId,
    piHosted: hosted,
    runtime,
    getMode: () =>
      (hosted.projector.getSnapshot().config.mode as CollaborationMode) || ("build" as CollaborationMode),
    listModels: () => {
      const listed = hosted.listModels();
      const models =
        listed.length > 0
          ? listed
          : [
              {
                providerId: hosted.projector.getSnapshot().config.provider || "pi",
                modelId: hosted.projector.getSnapshot().config.model || "default",
              },
            ];
      return models.map((model) => ({
        ref: { providerId: model.providerId, modelId: model.modelId },
        label: model.modelId,
        providerLabel: model.providerId,
        properties: { inputFormat: "text" as const, outputFormat: "text" as const },
      }));
    },
    listThoughtLevels: () => ["off", "low", "medium", "high"],
    async setMode(mode: CollaborationMode) {
      const previousMode =
        (hosted.projector.getSnapshot().config.mode as CollaborationMode) || ("build" as CollaborationMode);
      hosted.ui.autoConfirm = mode === "yolo";
      hosted.projector.setConfig({ mode });
      return { mode, previousMode, traceId: "pi-host" };
    },
    getModel: () => hosted.projector.getSnapshot().config.model,
    getThoughtLevel: () => hosted.projector.getSnapshot().config.thought,
    getLocale: () => "en" as const,
    getTheme: () => "system" as const,
    async sendInput(input: PromptInput, options?: { queueDelivery?: "guide"; inputId?: string }) {
      const streaming = hosted.projector.getSnapshot().control.phase === "running";
      const delivery = options?.queueDelivery === "guide" ? "guide" : streaming ? "queue" : "startNow";
      return send(input, delivery, options?.inputId);
    },
    async steerTurn(input: string, options?: { inputId?: string }) {
      return send(input, "guide", options?.inputId);
    },
    async enqueueDeferredInput(input: string, options?: { inputId?: string }) {
      return send(input, "queue", options?.inputId);
    },
    async removeQueueItem(id: string) {
      const next = hosted.queue.remove(id);
      if (next) hosted.projector.replaceQueue(next);
      return Boolean(next);
    },
    async editQueueItem(id: string, newText: string) {
      const next = hosted.queue.edit(id, newText);
      if (next) hosted.projector.replaceQueue(next);
      return Boolean(next);
    },
    async reorderQueueItem(id: string, before: string | null) {
      const next = hosted.queue.reorder(id, before);
      if (next) hosted.projector.replaceQueue(next);
      return Boolean(next);
    },
    async clearQueueItems() {
      const count = hosted.queue.snapshot().items.length;
      hosted.projector.replaceQueue(hosted.queue.clear());
      return count;
    },
    async setQueueAutoDrain(autoDrain: boolean) {
      hosted.queue.autoDrain = autoDrain;
      hosted.projector.replaceQueue(hosted.queue.snapshot());
    },
    async reserveQueueItem() {
      return true;
    },
    async markQueueItemPromoting() {
      return true;
    },
    async releaseQueueItemReservation() {
      return true;
    },
    completeExternalQueueDrain() {
      return;
    },
    async setFollowupMode(mode: "queue" | "guide") {
      hosted.bridge.syncFollowupMode(mode);
      hosted.projector.setConfig({ followupMode: mode });
    },
    async submitPrompt(input: PromptInput) {
      const text = textOf(input).trim();
      if (text === "/compact") {
        await hosted.compact();
        return dummyCompletion("compact");
      }
      const started = await send(input, "startNow");
      if (started.kind === "started_turn") return started.completion;
      throw new Error("pi-host submitPrompt queued");
    },
    async setModel(modelId: string | { providerId: string; modelId: string }) {
      const parsed =
        typeof modelId === "string"
          ? parseProviderQualifiedModelSelection(modelId)
          : { providerId: modelId.providerId, modelId: modelId.modelId };
      const provider = parsed?.providerId ?? "";
      const model = parsed?.modelId ?? (typeof modelId === "string" ? modelId : modelId.modelId);
      const previousModel = hosted.projector.getSnapshot().config.model || "";
      await hosted.setModel(provider, model);
      return { model, previousModel, thoughtLevel: hosted.projector.getSnapshot().config.thought, traceId: "pi-host" };
    },
    async setThoughtLevel(level: string) {
      hosted.setThinkingLevel(level);
      return { thoughtLevel: level, traceId: "pi-host" };
    },
    async close() {
      hosted.dispose();
    },
    async cancelBackgroundTask(workId: string) {
      if (options.abortWork) {
        const ok = await options.abortWork(workId);
        if (!ok) return { reason: "not_found" as const };
        return {};
      }
      await hosted.abort();
      return {};
    },
  };

  return app as unknown as ZCodeApp;
}
