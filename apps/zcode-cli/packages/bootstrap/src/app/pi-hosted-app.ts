import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { abortInflightNetworkFetches } from "@zcode/adapters/network";
import { planTurnFileRewind, readProcessSshRemoteSpec, sendDelivery, setInflightNetworkAbort, sshReadText, sshRemoveFile, sshWriteText, summarizeTurnFileChanges, type HostedSession } from "@zcode/pi-host";
import { remotePosixPath } from "@zcode/shared/node";
import { RewindStrategy, type CollaborationMode, type ModelSelection, type SessionId, type TurnId } from "@zcode/contracts";
import type { ZCodeApp, PromptInput, SendInputResult } from "./types.js";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

function textOf(input: PromptInput): string {
  return typeof input === "string" ? input : input.text;
}

const emptyRewind = {
  preview: { canApply: false, ignoredFiles: [], safeFiles: [], unsafeFiles: [] },
  restores: [] as Array<{ path: string; content: string }>,
  deletes: [] as string[],
};

async function rewindTurnFiles(hosted: HostedSession, turnId: TurnId | undefined) {
  if (!turnId) return emptyRewind;
  return planTurnFileRewind(
    hosted.projector.getSnapshot().rows.window,
    String(turnId),
    (path) => readTurnFile(hosted, path),
  );
}

function absoluteTurnPath(hosted: HostedSession, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(hosted.workspacePath, filePath);
}

async function readTurnFile(hosted: HostedSession, filePath: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  try {
    if (spec) {
      const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
      return { content: await sshReadText(spec, remote) };
    }
    return { content: await readFile(absoluteTurnPath(hosted, filePath), "utf8") };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || /no such file/i.test(message)) return { missing: true as const };
    return { error: message };
  }
}

async function writeTurnFile(hosted: HostedSession, filePath: string, content: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  if (spec) {
    const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
    await sshWriteText(spec, remote, content);
    return;
  }
  await writeFile(absoluteTurnPath(hosted, filePath), content, "utf8");
}

async function removeTurnFile(hosted: HostedSession, filePath: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  if (spec) {
    const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
    await sshRemoveFile(spec, remote);
    return;
  }
  await rm(absoluteTurnPath(hosted, filePath), { force: true });
}

export function createPiHostedApp(
  hosted: HostedSession,
  options: {
    abortWork?: (workId: string) => Promise<boolean>;
    persistSession?: (title: string) => Promise<void>;
  } = {},
): ZCodeApp {
  setInflightNetworkAbort(abortInflightNetworkFetches);
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
    modelSelection?: ModelSelection,
  ): Promise<SendInputResult> => {
    const streaming = hosted.projector.getSnapshot().control.phase === "running";
    const thought = modelSelection?.options?.reasoningLevel;
    const attachments = typeof input === "string" ? undefined : input.attachments;
    const result = await hosted.bridge.admitSend({
      text: textOf(input),
      clientId: "v4",
      commandId,
      delivery,
      streaming,
      ...(attachments?.length ? { attachments } : {}),
      ...(modelSelection
        ? {
            modelSelection: {
              providerId: modelSelection.providerId,
              modelId: modelSelection.modelId,
              ...(thought ? { thought } : {}),
            },
          }
        : {}),
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
    describeTurnFileChanges: (turnId: string) => {
      const summary = summarizeTurnFileChanges(hosted.projector.getSnapshot().rows.window, turnId);
      if (!summary) return null;
      const header = hosted.projector
        .getSnapshot()
        .rows.window.find((row) => row.kind === "turnHeader" && row.turnId === turnId);
      return {
        ...summary,
        ...(header && header.kind === "turnHeader" && header.fileChanges?.state
          ? { state: header.fileChanges.state }
          : {}),
      };
    },
    previewWorkspaceFileRewind: async (options?: { targetTurnId?: TurnId }) =>
      (await rewindTurnFiles(hosted, options?.targetTurnId)).preview,
    applyWorkspaceFileRewind: async (options?: {
      targetTurnId?: TurnId;
      commitAfterApply?: () => Promise<void>;
    }) => {
      const turnId = options?.targetTurnId ? String(options.targetTurnId) : "";
      const plan = await rewindTurnFiles(hosted, options?.targetTurnId);
      if (!plan.preview.canApply) {
        return {
          applied: false,
          preview: plan.preview,
          response: "File rewind was not applied because at least one file is unsafe.",
        };
      }
      const journal: Array<{ path: string; content: string | null; deleted: boolean }> = [];
      try {
        for (const file of plan.restores) {
          const current = await readTurnFile(hosted, file.path);
          const previous = "content" in current && typeof current.content === "string" ? current.content : null;
          journal.push({ path: file.path, content: previous, deleted: false });
          await writeTurnFile(hosted, file.path, file.content);
        }
        for (const path of plan.deletes) {
          const current = await readTurnFile(hosted, path);
          const previous = "content" in current && typeof current.content === "string" ? current.content : null;
          journal.push({ path, content: previous, deleted: true });
          await removeTurnFile(hosted, path);
        }
        await options?.commitAfterApply?.();
        if (turnId) hosted.markTurnFilesReverted(turnId);
      } catch (error) {
        try {
          for (const entry of [...journal].reverse()) {
            if (entry.deleted) {
              if (entry.content !== null) await writeTurnFile(hosted, entry.path, entry.content);
              continue;
            }
            if (entry.content === null) continue;
            await writeTurnFile(hosted, entry.path, entry.content);
          }
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            "Workspace file rewind failed and compensation was incomplete",
          );
        }
        return {
          applied: false,
          preview: { ...plan.preview, canApply: false },
          response: error instanceof Error ? error.message : String(error),
        };
      }
      return { applied: true, preview: plan.preview, response: "" };
    },
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
    restoreRewoundConversation: async () => {
      const content = await readFile(hosted.sessionFile, "utf8").catch(() => "");
      hosted.reloadHistory(content);
    },
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
        // inputFormat 必须是对象。字符串会让 readSession 校验失败，分叉后的侧栏行写不进去。
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
    getModel: () => {
      const config = hosted.projector.getSnapshot().config;
      // 旧 snapshot 只接受 provider/model。只给裸 id 会在 rewind 之后抛错，画面停在截断态。
      return config.provider && config.model ? `${config.provider}/${config.model}` : config.model;
    },
    getThoughtLevel: () => hosted.projector.getSnapshot().config.thought,
    getDefaultThoughtLevel: () => undefined,
    getLocale: () => "en" as const,
    getTheme: () => "system" as const,
    async writePromptAttachment(input: { fileName: string; mime: string; bytes: Uint8Array }) {
      // 粘贴的图没有本地路径。落成临时文件，后面跟选文件一样读给 Pi。
      const dir = join(tmpdir(), "picode-prompt-images");
      await mkdir(dir, { recursive: true });
      const safe = input.fileName.replace(/[^\w.-]+/g, "_").slice(0, 40) || "image";
      const file = join(dir, `${Date.now().toString(36)}-${safe}`);
      await writeFile(file, input.bytes);
      return { ref: file };
    },
    async readPromptAttachment(input: { ref: string; mime: string; maxBytes: number }) {
      const bytes = await readFile(input.ref);
      if (bytes.byteLength > input.maxBytes) throw new Error("fault.attachment.previewTooLarge");
      return { bytes, mediaType: input.mime };
    },
    async sendInput(input: PromptInput, options?: { queueDelivery?: "guide"; inputId?: string; intent?: { modelSelection?: ModelSelection } }) {
      const phaseRunning = hosted.projector.getSnapshot().control.phase === "running";
      const delivery = sendDelivery({
        guide: options?.queueDelivery === "guide",
        phaseRunning,
        idle: hosted.isIdle,
      });
      return send(input, delivery, options?.inputId, options?.intent?.modelSelection);
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
    // Pi 会话没有 goal。缺这个方法时 stop 会在 abort 之后抛 readTarget is not a function。
    async readTarget() {
      return null;
    },
    async readBackgroundBashOutput(workId: string) {
      return hosted.readManagedProcessOutput(workId);
    },
    async cancelBackgroundTask(workId: string) {
      const managed = await hosted.cancelManagedProcess(workId);
      if (managed === "killed") return {};
      if (managed === "missing") return { reason: "not_found" as const };
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
