// fork/edit/retry 命令组：forkAssistant / editUserQuery / retryTurn。
// 共同点：都以 {rowId, entityId} 定位历史实体，经 host 的 v4 投影翻译面换成 transcript messageId
// （翻译是 v4 原生决策，翻译不到直接 reject，绝不静默兜底 latestCheckpoint——会错点）。
// - editUserQuery = 换文本的 retryTurn：rewind 截断该 turn → 原生 prompt turn 重发新文本。
//   restoreToInput 只做同一条裁切，不重发、不回滚文件，原文由 UI 填回输入框。
// - retryTurn = rewind 截断 + 重发原 user prompt（原文必须在 rewind 前解析，截断后拿不到）。
// - forkAssistant = stable resolver + conversation-only copy；running parent 与 workspace 不动。
import type { ModelSelection } from "@zcode/shared";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { traceContextToLogContext, type MessageId, type TurnId } from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { commandAdmissionOf } from "../executor.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  hasPromptInput,
  preemptActiveTurnAndWait,
  V4InputAdmissionRejectedError,
} from "./session-flow.js";
import { applyGoalCommand } from "./goal-compact.js";
import {
  CONVERSATION_COMMAND_LOG_MODULE,
  restoreUserQueryToInput,
  submitConversationRewind,
} from "./conversation-rewind.js";
import type { ConversationEditTarget } from "../../product-projection.js";

const EDIT_USER_QUERY_COMPLETED_EVENT = "conversation.command.edit_user_query.completed";
const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

/** row target → messageId 翻译失败（非 assistant 行 / 迟到实体 / 会话无投影）。 */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} 无法解析到 transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** fork 目标不是所属轮最后一段 assistantText → 明确拒绝。 */
export class V4ForkTargetNotLatestSegmentError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(targetRowId: number) {
    super(
      `forkAssistant targetRowId ${targetRowId} 不是所属轮的最后一段 assistant（fork 只挂轮尾段）`,
    );
    this.name = "V4ForkTargetNotLatestSegmentError";
  }
}

class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} 被稳定目标解析器拒绝: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

/** 没有 canEdit 的 row / 非 realUser row / 无投影均直接拒绝，不 stop 当前 turn。 */
class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} 不是可编辑的 real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly：历史 assistant 回复 retry 会回退 active branch，必须拒绝。 */
class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} 不是最后一轮 assistant 回复`);
    this.name = "V4RetryTargetNotLatestError";
  }
}

/**
 * editUserQuery：target 是 user 实体，用其 canonical transcript messageId 作 rewind
 * 锚点 → 整段截断 → 原生 prompt turn 重发 newText。
 * 附件命令面：attachments（AttachmentRef → TurnAttachment）随重发提交。
 */
async function editUserQuery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  const record = requireRecord(host, envelope.sessionId);
  const summary = payload.summarize
    ? { summarize: true as const, customInstructions: payload.customInstructions }
    : undefined;
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "editUserQuery",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4EditTargetNotLatestError(payload.target.rowId);
  }
  const editTarget = resolution.editTarget;
  if (payload.restoreToInput) {
    // 回退到此处和编辑重发共用 navigateTree 裁切，但用户还没发出新内容。
    // workspaceMode=rewind 时先撤销锚点及之后所有 turn 的文件改动，两步在同一条命令内完成。
    return restoreUserQueryToInput({
      editTarget,
      envelope,
      host,
      record,
      summary,
      workspaceMode: payload.workspaceMode ?? "preserve",
    });
  }
  const attachmentRefs = payload.attachments ?? stableAttachmentRefs(editTarget);
  // attachments 缺省与 [] 语义不同；必须基于 effective refs 校验，
  // 才能同时允许 attachment-only edit，并在正文和附件都被清空时于 rewind 前拒绝。
  if (!hasPromptInput(payload.newText, attachmentRefs)) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  // 附件映射在 rewind 前完成：引用失效要在截断历史之前暴露，避免半程失败。
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  if (record.activeAbortController) {
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 editUserQuery preempts active turn",
      goalPausedMutationReason: "edit_user_query_goal_paused",
    });
  }
  let conversationRewindCommitted = false;
  if ((payload.workspaceMode ?? "preserve") === "rewind") {
    const turnMessageIds = resolution.messageIds ??
      host.getMessageIdsForTurnRow?.(record.app.sessionId, resolution.row.rowId) ?? [
        editTarget.transcriptMessageId,
      ];
    const fileOptions = {
      targetMessageIds: turnMessageIds as MessageId[],
      targetTurnId: resolution.row.turnId as TurnId,
      traceContext: record.traceContext,
    };
    const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
    // shell/ignored 变更无法证明完整回滚。组合模式 fail closed，并把最新 preview 原样返回 UI。
    if (!preview.canApply || preview.ignoredFiles.length > 0 || preview.safeFiles.length === 0) {
      const reasonCode =
        preview.unsafeFiles.length > 0
          ? "guard.workspaceRewindUnsafeFiles"
          : preview.ignoredFiles.length > 0
            ? "guard.workspaceRewindIgnoredFiles"
            : preview.safeFiles.length === 0
              ? "guard.workspaceRewindUnavailable"
              : "guard.workspaceRewindApplyConflict";
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        reasonCode,
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode,
        preview,
      };
    }
    const applied = await record.app.runtime.applyWorkspaceFileRewind({
      ...fileOptions,
      commitAfterApply: async () => {
        await submitConversationRewind(host, record, editTarget.transcriptMessageId, summary);
        conversationRewindCommitted = true;
      },
    });
    if (!applied.applied) {
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        "guard.workspaceRewindApplyConflict",
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode: "guard.workspaceRewindApplyConflict",
        preview: applied.preview,
      };
    }
  }
  let rewound = conversationRewindCommitted;
  try {
    if (!rewound) {
      // 截断发生在这次调用内部。抛错时赋值还没执行，必须先记上，失败才能画回原对话。
      rewound = true;
      await submitConversationRewind(host, record, editTarget.transcriptMessageId, summary);
    }
    await startCanonicalIntent(
      host,
      record,
      envelope,
      editTarget,
      payload.newText,
      attachmentRefs,
      attachments,
      payload.modelSelection,
    );
  } catch (error) {
    // rewind 之后的 snapshot/重发失败都会把旧行留在截断态。jsonl 还在就画回去。
    if (rewound) await record.app.restoreRewoundConversation?.();
    throw error;
  }
  // 生产 renderer 不落日志，过去只能从通用 rewind + send 猜测发生过编辑，
  // 无法与 retry 稳定区分。命令副作用完成后由 Agent server 写低频 info 审计索引。
  host.logger?.info?.("v4 editUserQuery completed", {
    ...traceContextToLogContext(record.traceContext),
    attachmentCount: attachmentRefs?.length ?? 0,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: EDIT_USER_QUERY_COMPLETED_EVENT,
    intentKind: editTarget.intent.kind,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * retryTurn：assistant target → 所属 user prompt → rewind 截断 + 重发
 * canonical user intent。intent 在 projection resolver 阶段、rewind **之前**完成解析，
 * 截断后不再回读可见文本或 transcript parent 猜测原输入。
 *
 * 不能用 assistant 的 messageId 当锚点。Pi 对非 user 节点把叶子停在该节点，旧回复仍在上下文里，
 * 原 prompt 再发一次时模型会当成已经做完，请求成功后直接停。
 */
async function retryTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["retryTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "retryTurn",
  );
  if (!resolution?.ok || !resolution.messageId || !resolution.editTarget) {
    throw new V4RetryTargetNotLatestError(payload.target.rowId);
  }
  const attachmentRefs = stableAttachmentRefs(resolution.editTarget);
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  try {
    await submitConversationRewind(host, record, resolution.editTarget.transcriptMessageId);
    await startCanonicalIntent(
      host,
      record,
      envelope,
      resolution.editTarget,
      resolution.editTarget.intent.text,
      attachmentRefs,
      attachments,
    );
  } catch (error) {
    await record.app.restoreRewoundConversation?.();
    throw error;
  }
  return undefined;
}

/**
 * forkAssistant：唯一 stable resolver 固定 logical-turn/message boundary，再走
 * conversation-only fork。此路径不读取 activeAbortController、不 stop parent，也不进入
 * legacy forkSession（后者含 ensureNoActiveTurn + workspace rewind）。
 */
async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
  });
  // fork 完成事实过去只在 session event/debug 中，生产默认 JSONL 无法直接检索。
  // child 已创建并完成宿主注册后再写 info，避免把被拒绝或失败的请求误记为成功。
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  // 编辑重发：输入框当前模型优先。不传则保持原轮模型（retry 与旧客户端）。
  modelSelection?: ModelSelection,
): Promise<void> {
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: editTarget.intent.kind,
      text: editTarget.intent.text,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: modelSelection ?? editTarget.intent.modelSelection,
      mode: editTarget.intent.mode,
      planEnabled: editTarget.intent.planEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    text,
  );
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {
      inputId: envelope.commandId,
      objective: text,
      intent,
    });
    return;
  }
  await startPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent,
    ...(attachments ? { attachments } : {}),
  });
}

export const forkEditRetryHandlers = {
  forkAssistant,
  editUserQuery,
  retryTurn,
};
