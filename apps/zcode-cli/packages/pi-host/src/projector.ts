import {
  applyConversationDeltas,
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

export interface ProjectorOptions {
  profile?: DeliveryProfileName;
  viaRegistry?: boolean;
  workId?: string;
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
  private aborted = false;
  private seq = 0;
  private assistantMessageId?: string;
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
  }

  apply(event: PiHostEvent): ConversationDelta[] {
    const reduced = this.reduce(event);
    if (reduced.length === 0) return [];
    this.seq += 1;
    let withSeq = this.attachRevision(reduced);
    this.snapshot = { ...applyConversationDeltas(this.snapshot, withSeq), seq: this.seq };
    const actions = this.syncActions();
    if (actions.length > 0) {
      this.seq += 1;
      const extra = this.attachRevision(actions);
      this.snapshot = { ...applyConversationDeltas(this.snapshot, extra), seq: this.seq };
      withSeq = [...withSeq, ...extra];
    }
    return withSeq;
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
    this.toolRowId.clear();
    this.toolArgs.clear();
    this.aborted = false;
    const cleared = this.commit([{ op: "row.removed", fromRowId: 1 }]);
    const rest: ConversationDelta[] = [];
    for (const event of events) rest.push(...this.apply(event));
    return [...cleared, ...rest];
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
    this.snapshot = { ...applyConversationDeltas(this.snapshot, withSeq), seq: this.seq };
    return withSeq;
  }

  replaceQueue(queue: QueueState): ConversationDelta[] {
    return this.applyState({ queue, inputRouting: this.routing(queue) });
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

  replaceSubagents(subagents: ConversationSnapshot["subagents"]): ConversationDelta[] {
    return this.applyState({ subagents });
  }

  setTitle(title: string, titleSource: ConversationSnapshot["meta"]["titleSource"] = "custom"): ConversationDelta[] {
    return this.applyState({ meta: { title, titleSource } });
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
        return event.willRetry ? [] : this.settleTurn();
      case "agent_settled":
        return this.settleTurn();
      case "message_end":
        return event.message.role === "assistant" ? this.flushAssistant(event.message.content) : [];
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

  private startTurn(): ConversationDelta[] {
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

  private appendUser(text: string, messageId?: string): ConversationDelta[] {
    if (!text && this.snapshot.control.phase === "draft") return [];
    const row: ConversationRow = {
      ...this.base(this.turnId || `turn:${this.nextRowId}`),
      kind: "userInput",
      text,
      origin: "realUser",
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
    return [{ op: "row.appended", row }];
  }

  private compactEnd(event: Extract<PiHostEvent, { type: "compaction_end" }>): ConversationDelta[] {
    const row = [...this.snapshot.rows.window].reverse().find((item) => item.kind === "timelineMarker");
    if (!row || row.kind !== "timelineMarker") return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          marker: {
            type: "compact",
            origin: "manual",
            status: event.aborted ? "cancelled" : event.result ? "success" : "failed",
            tokensBefore: event.result?.tokensBefore,
            tokensAfter: event.result?.estimatedTokensAfter,
          },
        },
      },
    ];
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
    const state = this.aborted ? "completedInterrupted" : "completedSuccess";
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
          lastError: null,
          apiRetry: null,
        },
        availability: emptyAvailability(false),
        inputRouting: this.routing(this.snapshot.queue),
      },
    });
    this.aborted = false;
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
