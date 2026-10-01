import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  DELIVERY_PROFILES,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type DeliveryProfileName,
  type PendingInteraction,
  type QueueState,
  type StatePatch,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { summarizeTurnFileChanges } from "./file-rewind.js";
import { PI_PROCESS_WORK_PREFIX } from "./pi-process-bridge.js";
import { bashDisplay, editDisplay, mapPiToolName, toolResultText } from "./presentation.js";
import { createEmptySnapshot, emptyAvailability } from "./snapshot.js";
import type { PiAssistantDelta, PiHostEvent } from "./types.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

/** 附件正文只给模型。气泡留用户原文，文件名走附件芯片。 */
function visibleUserText(text: string): string {
  return text.replace(/\n*<zcode-file>[\s\S]*?<\/zcode-file>/gu, "").trimEnd();
}

function clipError(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > 4000 ? `${flat.slice(0, 3999)}…` : flat;
}

function errorMessageOf(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if ("message" in value && typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }
  return "error" in value ? errorMessageOf(value.error, depth + 1) : undefined;
}

/** 横幅只留一句人话；原始 JSON 进 detail，避免整段网关响应铺在对话里。 */
function presentModelError(raw: string): { message: string; detail?: string } {
  const status = /^(\d{3})\b/.exec(raw)?.[1];
  const jsonAt = raw.indexOf("{");
  let summary = raw;
  if (jsonAt >= 0) {
    try {
      const parsed = errorMessageOf(JSON.parse(raw.slice(jsonAt)));
      if (parsed) summary = status ? `${status} ${parsed}` : parsed;
    } catch {
      summary = raw;
    }
  }
  const message = summary.length > 240 ? `${summary.slice(0, 239)}…` : summary;
  return message === raw ? { message } : { message, detail: raw };
}

export interface ProjectorOptions {
  profile?: DeliveryProfileName;
  viaRegistry?: boolean;
  workId?: string;
}

function sameBreakdown(
  left: ZCodeContextUsageBreakdownItem[] | undefined,
  right: ZCodeContextUsageBreakdownItem[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.source === right[index]?.source &&
      item.chars === right[index]?.chars &&
      item.tokens === right[index]?.tokens,
  );
}

export class PiToV4Projector {
  private snapshot: ConversationSnapshot;
  private nextRowId = 1;
  private turnId = "";
  private productTurnId = "";
  private streamingTextRowId: number | null = null;
  private streamingReasoningRowId: number | null = null;
  private readonly toolRowId = new Map<string, number>();
  private readonly toolArgs = new Map<string, string>();
  private readonly rowIndexById = new Map<number, number>();
  private aborted = false;
  private stopRequested = false;
  private seq = 0;
  private assistantMessageId?: string;
  private pendingError?: string;
  private pendingUserAttachments?: Extract<ConversationRow, { kind: "userInput" }>["attachments"];
  private retryFailures: { attempt: number; message: string }[] = [];
  private publishQueue: ((deltas: ConversationDelta[]) => void) | null = null;
  readonly profile: DeliveryProfileName;
  private readonly viaRegistry: boolean;
  private readonly workId?: string;

  constructor(sessionId: string, logEpoch: string, options: ProjectorOptions = {}) {
    this.snapshot = createEmptySnapshot(sessionId, logEpoch);
    this.profile = options.profile ?? "continuous";
    this.viaRegistry = options.viaRegistry ?? false;
    this.workId = options.workId;
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  markAborted(): void {
    this.aborted = true;
    this.stopRequested = true;
  }

  wantsStop(): boolean {
    return this.stopRequested;
  }

  apply(event: PiHostEvent): ConversationDelta[] {
    const reduced = this.reduce(event);
    if (reduced.length === 0) return [];
    const withSeq = this.commit(reduced);
    const actions = this.syncActions();
    return actions.length === 0 ? withSeq : [...withSeq, ...this.commit(actions)];
  }

  /**
   * 历史重放。每条事件都 syncActions 会扫整窗，3 万行的会话打开时主线程一直不回来。
   * 行先按事件落完，actions 只在最后算一次。
   */
  replay(events: readonly PiHostEvent[]): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    for (const event of events) {
      const reduced = this.reduce(event);
      if (reduced.length === 0) continue;
      for (const delta of this.commit(reduced)) deltas.push(delta);
    }
    for (const delta of this.commit(this.syncActions())) deltas.push(delta);
    return deltas;
  }

  truncateFrom(entityId: string): ConversationDelta[] {
    const row = this.snapshot.rows.window.find((item) => item.entityId === entityId);
    if (!row) return [];
    const header = this.snapshot.rows.window.find(
      (item) => item.kind === "turnHeader" && item.turnId === row.turnId,
    );
    const fromRowId = Math.min(header?.rowId ?? row.rowId, row.rowId);
    const removed = this.commit([{ op: "row.removed", fromRowId }]);
    const actions = this.syncActions();
    return actions.length === 0 ? removed : [...removed, ...this.commit(actions)];
  }

  /** 用 jsonl 事件换掉当前行。编辑失败时把画面恢复回来，避免停在空白。 */
  reload(events: PiHostEvent[]): ConversationDelta[] {
    this.nextRowId = 1;
    this.turnId = "";
    this.productTurnId = "";
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    this.assistantMessageId = undefined;
    this.pendingError = undefined;
    this.toolRowId.clear();
    this.toolArgs.clear();
    this.aborted = false;
    const cleared = this.commit([{ op: "row.removed", fromRowId: 1 }]);
    return cleared.concat(this.replay(events));
  }

  markTurnFilesReverted(turnId: string): ConversationDelta[] {
    const header = this.snapshot.rows.window.find(
      (item) => item.kind === "turnHeader" && item.turnId === turnId,
    );
    if (!header || header.kind !== "turnHeader" || !header.fileChanges) return [];
    const actions = { ...header.actions };
    delete actions.canRewindFiles;
    const next: Extract<ConversationRow, { kind: "turnHeader" }> = {
      ...header,
      fileChanges: { ...header.fileChanges, state: "reverted" },
      ...(Object.keys(actions).length > 0 ? { actions } : {}),
    };
    if (Object.keys(actions).length === 0) delete next.actions;
    return this.commit([{ op: "row.upserted", row: next }]);
  }

  setFeedback(
    entityId: string,
    feedback: "like" | "dislike" | null,
  ): ConversationDelta[] {
    const row = this.snapshot.rows.window.find(
      (item) => item.kind === "assistantText" && item.entityId === entityId,
    );
    if (!row || row.kind !== "assistantText") return [];
    const next = { ...row, ...(feedback ? { feedback } : {}) };
    if (!feedback) delete next.feedback;
    return this.commit([{ op: "row.upserted", row: next }]);
  }

  private commit(deltas: ConversationDelta[]): ConversationDelta[] {
    if (deltas.length === 0) return [];
    this.seq += 1;
    const withSeq = this.attachRevision(deltas);
    // 原地写入。按条复制 window 的话，长历史重放是 O(n²)，会话打不开。
    applyConversationDeltasMutable(
      { snapshot: this.snapshot, rowIndexById: this.rowIndexById },
      withSeq,
    );
    this.snapshot.seq = this.seq;
    return withSeq;
  }

  bindQueuePublish(publish: (deltas: ConversationDelta[]) => void): void {
    this.publishQueue = publish;
  }

  replaceQueue(queue: QueueState): ConversationDelta[] {
    const deltas = this.applyState({ queue, inputRouting: this.routing(queue) });
    this.publishQueue?.(deltas);
    return deltas;
  }

  replaceInteractions(pendingInteractions: PendingInteraction[]): ConversationDelta[] {
    return this.applyState({ pendingInteractions });
  }

  replaceWidgets(widgets: NonNullable<ConversationSnapshot["extensionWidgets"]>): ConversationDelta[] {
    return this.applyState({ extensionWidgets: widgets });
  }

  replaceStatuses(statuses: NonNullable<ConversationSnapshot["extensionStatuses"]>): ConversationDelta[] {
    return this.applyState({ extensionStatuses: statuses });
  }

  setConfig(patch: Partial<ConversationSnapshot["config"]>): ConversationDelta[] {
    return this.applyState({ config: { ...this.snapshot.config, ...patch } });
  }

  /** 分支总结不是一轮对话。清掉上一轮的停止，避免总结请求被当成重试再 abort。 */
  releaseStop(): void {
    this.stopRequested = false;
    this.aborted = false;
  }

  // ponytail: stopTargetKind 复用 compact，只为让停止键出现。不写 compact activeWork，界面不会画压缩条。
  noteBranchSummary(active: boolean): ConversationDelta[] {
    const control = this.snapshot.control;
    if (active) {
      return this.applyState({
        control: {
          ...control,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "compact",
        },
      });
    }
    const running = control.phase === "running";
    return this.applyState({
      control: {
        ...control,
        canStop: running,
        stopState: running ? control.stopState : "idle",
        stopTargetKind: running ? control.stopTargetKind : "unknown",
      },
    });
  }

  replaceSubagents(subagents: ConversationSnapshot["subagents"]): ConversationDelta[] {
    return this.applyState({ subagents });
  }

  replaceManagedProcesses(works: ConversationSnapshot["backgroundWorks"]): ConversationDelta[] {
    const kept = this.snapshot.backgroundWorks.filter(
      (work) => !work.workId.startsWith(PI_PROCESS_WORK_PREFIX),
    );
    const next = [...kept, ...works];
    const prev = this.snapshot.backgroundWorks;
    if (
      prev.length === next.length &&
      prev.every(
        (work, index) => work.workId === next[index]?.workId && work.title === next[index]?.title,
      )
    ) {
      return [];
    }
    return this.applyState({ backgroundWorks: next });
  }

  setTitle(title: string, titleSource: ConversationSnapshot["meta"]["titleSource"] = "custom"): ConversationDelta[] {
    return this.applyState({ meta: { title, titleSource } });
  }

  setContextUsage(
    usedTokens: number,
    maxTokens: number,
    breakdown?: ZCodeContextUsageBreakdownItem[],
  ): ConversationDelta[] {
    const current = this.snapshot.usage.contextWindow;
    const nextBreakdown = breakdown && breakdown.length > 0 ? breakdown : undefined;
    if (
      current?.usedTokens === usedTokens &&
      current.maxTokens === maxTokens &&
      sameBreakdown(current.breakdown, nextBreakdown)
    ) {
      return [];
    }
    return this.applyState({
      usage: {
        ...this.snapshot.usage,
        contextWindow: {
          usedTokens,
          maxTokens,
          autoCompactThresholdTokens: current?.autoCompactThresholdTokens ?? null,
          ...(current?.cache ? { cache: current.cache } : {}),
          ...(nextBreakdown ? { breakdown: nextBreakdown } : {}),
        },
      },
    });
  }

  private applyState(patch: StatePatch): ConversationDelta[] {
    const deltas: ConversationDelta[] = [{ op: "state.updated", patch }];
    this.seq += 1;
    const withSeq = this.attachRevision(deltas);
    this.snapshot = { ...applyConversationDeltas(this.snapshot, withSeq), seq: this.seq };
    return withSeq;
  }

  private attachRevision(deltas: ConversationDelta[]): ConversationDelta[] {
    const bump = deltas.some((delta) => delta.op !== "row.delta");
    if (!bump) return deltas;
    const revision = this.snapshot.revision + 1;
    const hasState = deltas.some((delta) => delta.op === "state.updated");
    const mapped = deltas.map((delta) => {
      if (delta.op !== "state.updated") return delta;
      return { ...delta, patch: { ...delta.patch, revision } };
    });
    return hasState ? mapped : [...mapped, { op: "state.updated", patch: { revision } }];
  }

  private routing(queue: QueueState): ConversationSnapshot["inputRouting"] {
    const running = this.snapshot.control.phase === "running";
    const followup = this.snapshot.config.followupMode;
    if (running) return { mode: followup === "guide" ? "guide" : "enqueue" };
    if (queue.items.length > 0 && !queue.autoDrain) return { mode: "choice" };
    return { mode: "startNow" };
  }

  private reduce(event: PiHostEvent): ConversationDelta[] {
    switch (event.type) {
      case "agent_start":
        return this.startTurn();
      case "agent_end":
        if (event.willRetry) {
          this.pendingError = undefined;
          return [];
        }
        return this.settleTurn();
      case "auto_retry_start":
        return this.noteRetry(event);
      case "auto_retry_end":
        if (!event.success || !this.snapshot.control.apiRetry) return [];
        this.retryFailures = [];
        return this.applyState({
          control: { ...this.snapshot.control, apiRetry: null },
        });
      case "agent_settled":
        return this.settleTurn();
      case "message_end":
        if (event.message.role !== "assistant") return [];
        this.pendingError = clipError(
          event.message.stopReason === "error" ? event.message.errorMessage : undefined,
        );
        return this.flushAssistant(event.message.content);
      case "message_start":
        if (event.message.role === "assistant") {
          // 同一轮里 Pi 会连续写多条 assistant（工具来回、插件 custom_message）。
          // 上一条正文留下的 streaming 行会让 flushAssistant 把后面的正文全部丢掉。
          if (!event.message.id || event.message.id !== this.assistantMessageId) {
            this.streamingTextRowId = null;
            this.streamingReasoningRowId = null;
          }
          if (event.message.id) this.assistantMessageId = event.message.id;
          return [];
        }
        return event.message.role === "user"
          ? this.appendUser(messageText(event.message.content), event.message.id)
          : [];
      case "message_update":
        return this.stream(event.assistantMessageEvent);
      case "tool_execution_start":
        return this.toolStart(event);
      case "tool_execution_update":
        return this.toolUpdate(event);
      case "tool_execution_end":
        return this.toolEnd(event);
      case "compaction_start":
        return this.compactStart();
      case "compaction_end":
        return this.compactEnd(event);
      case "branch_summary":
        return [
          {
            op: "row.appended",
            row: {
              ...this.base(this.turnId || "branch"),
              kind: "timelineMarker",
              lane: "turnTailBoundary",
              marker: { type: "branchSummary", summary: event.summary },
            },
          },
        ];
      case "extension_error":
        return this.applyState({
          control: {
            ...this.snapshot.control,
            lastError: {
              code: "fault.extension",
              message: event.error,
              recoverable: true,
              at: Date.now(),
              source: "runtime" as const,
            },
          },
        });
      default:
        return [];
    }
  }

  private base(turnId = this.turnId || "turn") {
    const rowId = this.nextRowId++;
    return {
      rowId,
      turnId,
      entityId: `row:${rowId}`,
      productTurnId: this.productTurnId || turnId,
      createdAt: Date.now(),
      createdAtSeq: rowId,
    };
  }

  private noteRetry(event: Extract<PiHostEvent, { type: "auto_retry_start" }>): ConversationDelta[] {
    const presented = presentModelError(event.errorMessage);
    this.retryFailures = [...this.retryFailures, { attempt: event.attempt, message: presented.message }].slice(-20);
    return [
      {
        op: "state.updated",
        patch: {
          control: {
            ...this.snapshot.control,
            // 展示层把 maxAttempts 当成「含首次请求」。Pi 这里给的是重试上限。
            apiRetry: {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts + 1,
              nextRetryAt: Date.now() + Math.max(0, event.delayMs),
              reasonCode: presented.message,
              failures: this.retryFailures,
            },
          },
        },
      },
    ];
  }

  private startTurn(): ConversationDelta[] {
    // Pi 重试会再发 agent_start。上一轮还在跑时不能再开一条「工作中」。
    if (this.snapshot.control.phase === "running" && this.turnId) {
      // 重试的下一次请求不能把用户已经按过的停止清掉。
      if (!this.stopRequested) this.aborted = false;
      this.streamingTextRowId = null;
      this.streamingReasoningRowId = null;
      this.assistantMessageId = undefined;
      return [];
    }
    this.pendingError = undefined;
    this.retryFailures = [];
    this.stopRequested = false;
    this.aborted = false;
    this.turnId = `turn:${this.nextRowId}`;
    this.productTurnId = this.turnId;
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    this.assistantMessageId = undefined;
    const header: ConversationRow = {
      ...this.base(this.turnId),
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state: "running",
      startedAt: Date.now(),
    };
    return [
      { op: "row.appended", row: header },
      {
        op: "state.updated",
        patch: {
          control: {
            phase: "running",
            sessionEnded: false,
            canStop: true,
            stopState: "stoppable",
            stopTargetKind: "assistant",
            activeWorks: [
              {
                kind: "primaryTurn",
                startedAt: Date.now(),
                ...(this.workId ? { foregroundExecutionId: this.workId } : {}),
              },
            ],
            lastError: null,
            apiRetry: null,
          },
          availability: emptyAvailability(true),
          inputRouting: this.routing(this.snapshot.queue),
        },
      },
    ];
  }

  noteUserAttachments(attachments: Extract<ConversationRow, { kind: "userInput" }>["attachments"]): void {
    this.pendingUserAttachments = attachments?.length ? attachments : undefined;
  }

  private appendUser(text: string, messageId?: string): ConversationDelta[] {
    const attachments = this.pendingUserAttachments;
    this.pendingUserAttachments = undefined;
    text = visibleUserText(text);
    if (!text && !attachments?.length && this.snapshot.control.phase === "draft") return [];
    const row: ConversationRow = {
      ...this.base(this.turnId || `turn:${this.nextRowId}`),
      kind: "userInput",
      text,
      origin: "realUser",
      ...(attachments?.length ? { attachments } : {}),
    };
    if (messageId) row.entityId = messageId;
    const deltas: ConversationDelta[] = [{ op: "row.appended", row }];
    const title = text.trim();
    if (title && (this.snapshot.meta.titleSource === "default" || !this.snapshot.meta.title)) {
      const compact = title.replace(/\s+/gu, " ");
      deltas.push({
        op: "state.updated",
        patch: {
          meta: {
            title: compact.length > 60 ? `${compact.slice(0, 59)}…` : compact,
            titleSource: "generated",
          },
        },
      });
    }
    return deltas;
  }

  private stream(delta: PiAssistantDelta): ConversationDelta[] {
    const paths = DELIVERY_PROFILES[this.profile].streamPaths;
    if (delta.type === "text_delta") {
      return this.appendStream("text", delta.delta ?? "", paths.text, "assistantText");
    }
    if (delta.type === "thinking_delta") {
      return this.appendStream("text", delta.delta ?? "", paths.text, "reasoning");
    }
    if (delta.type === "text_end" || delta.type === "thinking_end") {
      const rowId = delta.type === "text_end" ? this.streamingTextRowId : this.streamingReasoningRowId;
      if (rowId == null) return [];
      const row = this.snapshot.rows.window.find((item) => item.rowId === rowId);
      if (!row || (row.kind !== "assistantText" && row.kind !== "reasoning")) return [];
      return [{ op: "row.upserted", row: { ...row, state: "complete" } }];
    }
    if (delta.type === "toolcall_start") {
      if (!delta.id) return [];
      this.toolArgs.set(delta.id, "");
      if (!delta.toolName) return [];
      return this.ensureToolRow(delta.id, delta.toolName, "inputStreaming", "");
    }
    if (delta.type === "toolcall_delta") {
      const id = [...this.toolArgs.keys()].at(-1);
      if (!id) return [];
      const next = (this.toolArgs.get(id) ?? "") + delta.delta;
      this.toolArgs.set(id, next);
      const rowId = this.toolRowId.get(id);
      if (rowId == null) return [];
      if (DELIVERY_PROFILES[this.profile].streamPaths.inputText) {
        return [{ op: "row.delta", rowId, path: "inputText", append: delta.delta }];
      }
      return [];
    }
    if (delta.type === "toolcall_end" && delta.toolCall) {
      const inputText =
        typeof delta.toolCall.arguments === "string"
          ? delta.toolCall.arguments
          : JSON.stringify(delta.toolCall.arguments ?? {});
      this.toolArgs.set(delta.toolCall.id, inputText);
      return this.ensureToolRow(delta.toolCall.id, delta.toolCall.name, "inputStreaming", inputText, true);
    }
    return [];
  }

  private appendStream(
    path: "text",
    append: string,
    stream: boolean,
    kind: "assistantText" | "reasoning",
  ): ConversationDelta[] {
    const currentId = kind === "assistantText" ? this.streamingTextRowId : this.streamingReasoningRowId;
    if (currentId == null) {
      const row: ConversationRow =
        kind === "assistantText"
          ? { ...this.base(), kind, text: stream ? append : "", state: "streaming" }
          : { ...this.base(), kind, text: stream ? append : "", state: "streaming" };
      if (kind === "assistantText" && this.assistantMessageId) row.entityId = this.assistantMessageId;
      if (kind === "assistantText") this.streamingTextRowId = row.rowId;
      else this.streamingReasoningRowId = row.rowId;
      if (!stream) {
        return [{ op: "row.appended", row: { ...row, text: append, state: "streaming" } }];
      }
      return [{ op: "row.appended", row }];
    }
    if (stream) return [{ op: "row.delta", rowId: currentId, path, append }];
    const row = this.snapshot.rows.window.find((item) => item.rowId === currentId);
    if (!row || (row.kind !== "assistantText" && row.kind !== "reasoning")) return [];
    return [{ op: "row.upserted", row: { ...row, text: row.text + append } }];
  }

  private ensureToolRow(
    toolCallId: string,
    toolName: string,
    status: ToolCallRow["status"],
    inputText: string,
    replace = false,
  ): ConversationDelta[] {
    const mapped = mapPiToolName(toolName, this.viaRegistry);
    const existing = this.toolRowId.get(toolCallId);
    const row: ToolCallRow = {
      ...(existing != null
        ? (this.snapshot.rows.window.find((item) => item.rowId === existing) as ToolCallRow)
        : this.base()),
      kind: "toolCall",
      toolCallId,
      toolName: mapped,
      status,
      inputText,
      ...(this.workId ? { workId: this.workId } : {}),
    };
    if (existing == null) {
      this.toolRowId.set(toolCallId, row.rowId);
      return [{ op: "row.appended", row }];
    }
    return replace || existing != null ? [{ op: "row.upserted", row: { ...row, rowId: existing } }] : [];
  }

  private toolStart(event: Extract<PiHostEvent, { type: "tool_execution_start" }>): ConversationDelta[] {
    if (event.args !== undefined) this.toolArgs.set(event.toolCallId, JSON.stringify(event.args));
    const inputText = this.toolArgs.get(event.toolCallId) ?? "";
    return this.ensureToolRow(event.toolCallId, event.toolName, "running", inputText, true);
  }

  private toolUpdate(event: Extract<PiHostEvent, { type: "tool_execution_update" }>): ConversationDelta[] {
    const rowId = this.toolRowId.get(event.toolCallId);
    if (rowId == null) return [];
    const row = this.snapshot.rows.window.find((item) => item.rowId === rowId);
    if (!row || row.kind !== "toolCall") return [];
    const text = toolResultText(event.partialResult);
    const profile = DELIVERY_PROFILES[this.profile];
    const next: ToolCallRow = {
      ...row,
      outputPreview: text
        ? {
            text: text.slice(0, 4096),
            fullText: text.slice(0, 4096),
            totalLines: text.split("\n").length,
            totalBytes: text.length,
            linesEstimated: false,
          }
        : row.outputPreview,
      progress:
        profile.toolProgress && text
          ? { bytes: text.length, previewLine: text.slice(0, 200), updatedAt: Date.now() }
          : undefined,
    };
    return [{ op: "row.upserted", row: next }];
  }

  private toolEnd(event: Extract<PiHostEvent, { type: "tool_execution_end" }>): ConversationDelta[] {
    const rowId = this.toolRowId.get(event.toolCallId);
    const existing = this.snapshot.rows.window.find((item) => item.rowId === rowId);
    const inputText =
      this.toolArgs.get(event.toolCallId) ||
      (existing && existing.kind === "toolCall" ? existing.inputText : "");
    if (rowId == null) {
      return this.ensureToolRow(
        event.toolCallId,
        event.toolName,
        event.isError ? "error" : "success",
        inputText,
      );
    }
    const row = this.snapshot.rows.window.find((item) => item.rowId === rowId);
    if (!row || row.kind !== "toolCall") return [];
    const text = toolResultText(event.result);
    const details = event.result?.details;
    const mapped = mapPiToolName(event.toolName, this.viaRegistry);
    const display =
      mapped === "Edit"
        ? editDisplay(details)
        : mapped === "Bash"
          ? bashDisplay(text, details)
          : undefined;
    const next: ToolCallRow = {
      ...row,
      toolName: mapped,
      status: this.aborted ? "cancelled" : event.isError ? "error" : "success",
      output: {
        text,
        ...(display ? { display: display as NonNullable<NonNullable<ToolCallRow["output"]>["display"]> } : {}),
      },
      ...(event.isError ? { error: { code: "tool.error", message: text || "tool failed" } } : {}),
      outputPreview: undefined,
      progress: undefined,
      endedAt: Date.now(),
    };
    return [{ op: "row.upserted", row: next }];
  }

  private compactStart(): ConversationDelta[] {
    const row: ConversationRow = {
      ...this.base(this.turnId || "compact"),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker: { type: "compact", origin: "manual", status: "running" },
    };
    const deltas: ConversationDelta[] = [{ op: "row.appended", row }];
    // 空闲时压缩没有 running 轮次。不打开 canStop，停止键不会出现。
    if (this.snapshot.control.phase !== "running") {
      deltas.push({
        op: "state.updated",
        patch: {
          control: {
            ...this.snapshot.control,
            canStop: true,
            stopState: "stoppable",
            stopTargetKind: "compact",
            activeWorks: [{ kind: "compact", startedAt: Date.now() }],
          },
        },
      });
    }
    return deltas;
  }

  private compactEnd(event: Extract<PiHostEvent, { type: "compaction_end" }>): ConversationDelta[] {
    const presented = event.errorMessage
      ? presentModelError(event.errorMessage.replace(/^Compaction failed:\s*/i, ""))
      : undefined;
    const status: "cancelled" | "success" | "failed" = event.aborted
      ? "cancelled"
      : event.result
        ? "success"
        : "failed";
    const marker = {
      type: "compact" as const,
      origin: "manual" as const,
      status,
      tokensBefore: event.result?.tokensBefore,
      tokensAfter: event.result?.estimatedTokensAfter,
      ...(event.result?.summary ? { summary: event.result.summary } : {}),
      ...(presented ? { error: presented.message } : {}),
    };
    // 只收口这次正在跑的压缩。倒序碰到的任意 marker 可能是模型切换，
    // 盖上去会让失败从时间线上消失。
    const existing = [...this.snapshot.rows.window].reverse().find(
      (item) =>
        item.kind === "timelineMarker" &&
        item.marker.type === "compact" &&
        item.marker.status === "running",
    );
    const deltas: ConversationDelta[] = [
      existing && existing.kind === "timelineMarker"
        ? { op: "row.upserted", row: { ...existing, marker } }
        : {
            op: "row.appended",
            row: {
              ...this.base(this.turnId || "compact"),
              kind: "timelineMarker",
              lane: "assistantWork",
              marker,
            },
          },
    ];
    let control = this.snapshot.control;
    if (control.phase !== "running") {
      control = {
        ...control,
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      };
    }
    if (status === "failed" && presented) {
      control = {
        ...control,
        lastError: {
          code: "fault.compact",
          message: presented.message,
          ...(presented.detail ? { detail: presented.detail } : {}),
          recoverable: true,
          at: Date.now(),
          source: "runtime",
        },
      };
    } else if (
      (status === "success" || status === "cancelled") &&
      control.lastError?.code === "fault.compact"
    ) {
      control = { ...control, lastError: null };
    }
    if (control !== this.snapshot.control) {
      deltas.push({ op: "state.updated", patch: { control } });
    }
    return deltas;
  }

  private flushAssistant(content: unknown): ConversationDelta[] {
    if (this.streamingTextRowId != null || this.streamingReasoningRowId != null) return [];
    let thinking = "";
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if ("thinking" in part && typeof part.thinking === "string") thinking += part.thinking;
        if ("text" in part && typeof part.text === "string") text += part.text;
      }
    }
    const deltas: ConversationDelta[] = [];
    if (thinking) {
      const row: ConversationRow = {
        ...this.base(),
        kind: "reasoning",
        text: thinking,
        state: "complete",
      };
      this.streamingReasoningRowId = row.rowId;
      deltas.push({ op: "row.appended", row });
    }
    if (text) {
      const row: ConversationRow = {
        ...this.base(),
        kind: "assistantText",
        text,
        state: "complete",
      };
      if (this.assistantMessageId) row.entityId = this.assistantMessageId;
      this.streamingTextRowId = row.rowId;
      deltas.push({ op: "row.appended", row });
    }
    return deltas;
  }

  private settleTurn(): ConversationDelta[] {
    // agent_end 已经收过口时，紧跟着的 agent_settled 不能把 interrupted 盖成 success。
    if (this.snapshot.control.phase !== "running") return [];
    const errorText = this.pendingError;
    this.pendingError = undefined;
    const presented = errorText ? presentModelError(errorText) : undefined;
    if (presented) {
      const attempt = (this.retryFailures.at(-1)?.attempt ?? 0) + 1;
      this.retryFailures = [...this.retryFailures, { attempt, message: presented.message }].slice(-20);
    }
    const state = this.aborted ? "completedInterrupted" : "completedSuccess";
    const failureLines = this.retryFailures.map((failure) => `${failure.attempt}. ${failure.message}`);
    if (presented?.detail) failureLines.push(presented.detail);
    const detail = failureLines.length > 1 || presented?.detail ? failureLines.join("\n") : undefined;
    const deltas: ConversationDelta[] = [];
    for (const row of this.snapshot.rows.window) {
      if (row.kind === "turnHeader" && row.turnId === this.turnId && row.state === "running") {
        deltas.push({
          op: "row.upserted",
          row: { ...row, state, endedAt: Date.now() },
        });
      }
      if (row.kind === "assistantText" && row.state === "streaming") {
        deltas.push({ op: "row.upserted", row: { ...row, state: this.aborted ? "interrupted" : "complete" } });
      }
      if (row.kind === "reasoning" && row.state === "streaming") {
        deltas.push({ op: "row.upserted", row: { ...row, state: this.aborted ? "interrupted" : "complete" } });
      }
      if (row.kind === "toolCall" && (row.status === "running" || row.status === "inputStreaming")) {
        deltas.push({
          op: "row.upserted",
          row: { ...row, status: this.aborted ? "cancelled" : "error", endedAt: Date.now() },
        });
      }
    }
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    deltas.push({
      op: "state.updated",
      patch: {
        control: {
          phase: this.aborted ? "completedInterrupted" : "completedSuccess",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          lastError: presented
            ? {
                code: "fault.model",
                message: presented.message,
                ...(detail ? { detail } : {}),
                recoverable: true,
                at: Date.now(),
                source: "runtime" as const,
              }
            : this.snapshot.control.phase === "running"
              ? null
              : this.snapshot.control.lastError,
          apiRetry: null,
        },
        availability: emptyAvailability(false),
        inputRouting: this.routing(this.snapshot.queue),
      },
    });
    this.aborted = false;
    this.stopRequested = false;
    return deltas;
  }

  private syncActions(): ConversationDelta[] {
    const running = this.snapshot.control.phase === "running";
    const users = this.snapshot.rows.window.filter(
      (row) => row.kind === "userInput" && row.origin === "realUser",
    );
    const assistants = this.snapshot.rows.window.filter(
      (row) => row.kind === "assistantText" && row.state === "complete",
    );
    const latestUser = users.at(-1);
    const latestAssistant = assistants.at(-1);
    const forkRowByTurn = new Map<string, number>();
    for (const row of assistants) forkRowByTurn.set(row.turnId, row.rowId);
    const blocked = running || this.snapshot.pendingInteractions.length > 0;
    const deltas: ConversationDelta[] = [];
    for (const row of this.snapshot.rows.window) {
      if (row.kind === "turnHeader") {
        const next = this.turnHeaderWithFileChanges(row, blocked);
        if (next) deltas.push({ op: "row.upserted", row: next });
        continue;
      }
      if (row.kind !== "userInput" && row.kind !== "assistantText") continue;
      const forkable =
        !running &&
        row.kind === "assistantText" &&
        forkRowByTurn.get(row.turnId) === row.rowId;
      const nextActions =
        !running && row.kind === "userInput" && row.rowId === latestUser?.rowId
          ? { canEdit: true as const, editDisposition: "rewind" as const }
          : forkable && row.rowId === latestAssistant?.rowId
            ? { canRetry: true as const, canFork: true as const }
            : forkable
              ? { canFork: true as const }
              : undefined;
      if (JSON.stringify(row.actions) === JSON.stringify(nextActions)) continue;
      const next = { ...row, actions: nextActions };
      if (!nextActions) delete next.actions;
      deltas.push({ op: "row.upserted", row: next });
    }
    return deltas;
  }

  private turnHeaderWithFileChanges(
    row: Extract<ConversationRow, { kind: "turnHeader" }>,
    blocked: boolean,
  ): ConversationRow | null {
    const summary = summarizeTurnFileChanges(this.snapshot.rows.window, row.turnId);
    const fileChanges = summary
      ? {
          additions: summary.additions,
          deletions: summary.deletions,
          files: summary.files,
          state: row.fileChanges?.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }
      : undefined;
    const actions = { ...row.actions };
    if (fileChanges?.state === "active" && row.state !== "running" && !blocked) {
      actions.canRewindFiles = true;
    } else {
      delete actions.canRewindFiles;
    }
    const nextActions = Object.keys(actions).length > 0 ? actions : undefined;
    if (
      JSON.stringify(row.fileChanges) === JSON.stringify(fileChanges) &&
      JSON.stringify(row.actions) === JSON.stringify(nextActions)
    ) {
      return null;
    }
    const next: Extract<ConversationRow, { kind: "turnHeader" }> = {
      ...row,
      ...(nextActions ? { actions: nextActions } : {}),
    };
    if (!nextActions) delete next.actions;
    if (fileChanges) next.fileChanges = fileChanges;
    else delete next.fileChanges;
    return next;
  }
}
