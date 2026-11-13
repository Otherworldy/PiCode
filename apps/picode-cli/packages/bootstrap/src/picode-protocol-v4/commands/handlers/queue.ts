import {
  setSessionAutoDrain,
  setSessionFollowupMode,
} from "../../../picode-protocol/session-config.js";
import { legacyApp, sessionIdOf } from "../../../picode-protocol/session-owner.js";
// queue 命令组：deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
// 决策逻辑直驱 core（app 层 queue API，批1 已搬运）；queueItemId ≡ core 的
// pendingInputId（同一 id 空间，无需翻译）。queue 变更的事件由 core runtime 自发，
// 经 gateway ingest 推进 v4 投影——本组不需要 legacy 广播钩子。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@picode/shared/picode-protocol-v4";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow 在投影里查不到该项原文（已被 drain/删除或 id 无效）→ 拒绝。 */
class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

/** 撤回已不可逆，但宿主没有账本收口能力：不能静默 accepted，必须报错并保留 live pin。 */
class V4GuideCancelUnavailableError extends Error {
  readonly reasonCode = "fault.command.inputSettlementUnavailable";
  constructor(queueItemId: string) {
    super(`v4 deleteQueueItem cannot settle cancelled guide input: ${queueItemId}`);
    this.name = "V4GuideCancelUnavailableError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  if (record.hosted) {
    const hosted = record.hosted;
    const queueItem = hosted.queue
      .snapshot()
      .items.find((item) => item.queueItemId === payload.queueItemId);
    // 已交付 SDK 的 GUIDE 是 SDK 原始消息的权威生命周期事实：普通 remove 只覆盖 queued，
    // 这里必须先同步撤回 SDK 消息（撤回与取走在同一裁决点），再收口账本。
    if (queueItem?.delivery.admitted === "guide" && queueItem.dispatch.state === "reserved") {
      // 准入尚在提交时 SDK 对象可能还未入队，不能误报成消费获胜；等到 steering 后再允许撤回。
      if (queueItem.steer.state !== "steering")
        throw new V4QueueItemReservedError(payload.queueItemId);
      const settle = host.cancelPendingGuideInput;
      if (!settle) throw new V4GuideCancelUnavailableError(payload.queueItemId);
      // SDK 已取走时保留待生效事实；取消待账本确认时重试只结算账本，不再访问 SDK。
      if (!hosted.bridge.cancelGuide(payload.queueItemId)) {
        host.logger?.warn?.("v4 deleteQueueItem guide already claimed", {
          queueItemId: payload.queueItemId,
          sessionId: sessionIdOf(record),
        });
        throw new V4CommandNoopError("queue.itemMissing");
      }
      hosted.projector.replaceQueue(hosted.queue.snapshot());
      await settle(sessionIdOf(record), {
        sourceCommandId: queueItem.sourceCommandId,
        clientId: queueItem.clientId,
      });
      hosted.queue.consume(queueItem.sourceCommandId);
      hosted.projector.replaceQueue(hosted.queue.snapshot());
      return undefined;
    }
  }
  // 普通 FIFO consumer 不会取 reserved GUIDE；撤回 SDK 输入不改写它已读取的普通项。
  if (record.hosted?.queue.consumerReleased)
    throw new V4QueueItemReservedError(payload.queueItemId);
  // 未命中（并发 drain/重复删除的竞态）= noop，不算失败；留 warn 供观测。
  const removed = record.hosted
    ? record.hosted.queue.remove(payload.queueItemId)
    : await legacyApp(record).removeQueueItem(payload.queueItemId);
  if (record.hosted && removed)
    record.hosted.projector.replaceQueue(record.hosted.queue.snapshot());
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: sessionIdOf(record),
    });
    // 未命中曾返回 undefined，gateway 会把并发 drain/重复删除误报为 accepted；
    // queue 撤回编辑因此可能把已消费的旧投影再次恢复到 composer。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  if (record.hosted?.queue.consumerReleased)
    throw new V4QueueItemReservedError(payload.queueItemId);
  const queueItem = host.getQueueItem?.(sessionIdOf(record), payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact 是 typed maintenance intent；允许改文本会把它伪装成普通输入，
    // 但 commandKind 仍是 compact，消费时产生与 UI 文案不一致的压缩副作用。
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // core reducer 同 id 原地更新（保位）；未命中 = noop + warn（同 delete 的竞态语义）。
  const edited = record.hosted
    ? record.hosted.queue.edit(payload.queueItemId, payload.newText)
    : await legacyApp(record).editQueueItem(payload.queueItemId, payload.newText);
  if (record.hosted && edited) record.hosted.projector.replaceQueue(record.hosted.queue.snapshot());
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: sessionIdOf(record),
    });
  }
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  if (record.hosted?.queue.consumerReleased)
    throw new V4QueueItemReservedError(payload.queueItemId);
  // beforeQueueItemId = null → 移到队尾（协议与 app API 同形，直传）。
  const moved = record.hosted
    ? record.hosted.queue.reorder(payload.queueItemId, payload.beforeQueueItemId)
    : await legacyApp(record).reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (record.hosted && moved) record.hosted.projector.replaceQueue(record.hosted.queue.snapshot());
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: sessionIdOf(record),
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await setSessionAutoDrain(record, payload.autoDrain);
  if (payload.autoDrain) {
    // 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首。复用 CLI
    // 权威 ready hook，busy 时只武装，idle 时立即按 sendQueuedNow 原子路径提升。
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await setSessionFollowupMode(record, payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - 必须读取完整 QueueItem；text-only fallback 会丢 sourceCommandId/附件/client/order，禁止使用。
 * - stop 复用 session-flow 的语义：goal-pause barrier（否则 verifier 未收 abort 时
 *   queue 无法 drain）→ abort；只 abort 不 await。
 * - 等 idle 语义：锁由后台 turn 的 finally 释放（见 prompt-turn 文件头 3），
 *   abort 后立刻重发会撞 "A prompt is already running"，必须轮询等锁释放。
 * - start 之前任一步失败都 release reservation，原项原位保留；start 成功后才 remove。
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  if (record.hosted) {
    const hosted = record.hosted;
    const item = hosted.queue
      .snapshot()
      .items.find((item) => item.queueItemId === payload.queueItemId);
    if (!item) throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    // GUIDE 已归 SDK 消费；必须在抢占旧轮之前拒绝，不能中止后再靠 remove 失败兜底。
    if (item.dispatch.state !== "queued") throw new V4QueueItemReservedError(payload.queueItemId);
    const automatic = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
    if (automatic && (!hosted.isIdle || !hosted.queue.canAutoDrain)) {
      throw new V4QueuePromotionLeaseUnavailableError();
    }
    // 与 Registry 共用真实消费占用，覆盖模型、附件和抢占的所有 await 窗口。
    const consumer = hosted.queue.tryAcquireConsumer();
    if (!consumer) throw new V4QueuePromotionLeaseUnavailableError();
    try {
      if (!automatic)
        await preemptActiveTurnAndWait(host, record, {
          abortMessage: "send queued now",
          goalPausedMutationReason: "send_queued_now",
          preserveQueueAutoDrainOnCancel: true,
        });
      if (item.kind === "compact")
        await startManualCompact(
          host,
          record,
          item.sourceCommandId,
          undefined,
          item.modelSelection,
        );
      else {
        if (item.kind !== "sendText") throw new Error("guard.capabilityUnsupported");
        const attachments = await mapAttachmentRefsToTurnAttachments(record.app, item.attachments);
        const started = await startPromptTurn(host, record, {
          content: item.text,
          inputId: item.sourceCommandId,
          intent: inputIntentMetadataFromQueueItem(item, item.text),
          requireIdle: true,
          hostedConsumer: consumer,
          ...(attachments ? { attachments } : {}),
        });
        if (started.admission.kind === "queued" || started.admission.kind === "rejected")
          throw new V4QueuePromotionLeaseUnavailableError();
      }
      if (!hosted.queue.remove(item.queueItemId))
        throw new V4QueuePromotionCommitError(item.queueItemId);
    } finally {
      consumer.release();
      hosted.projector.replaceQueue(hosted.queue.snapshot());
    }
    await host.afterLegacyStateMutation?.(record, "queue_promoted");
    return undefined;
  }
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(sessionIdOf(record), payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = legacyApp(record).runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (
      !(await legacyApp(record).reserveQueueItem(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await legacyApp(record).markQueueItemPromoting(
        payload.queueItemId,
        reservationId,
        traceOptions,
      ))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      await startManualCompact(
        host,
        record,
        queueItem.sourceCommandId,
        foregroundPromotionLeaseId,
        queueItem.modelSelection,
      );
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        legacyApp(record).runtime?.getPlanEnabled?.() ??
        legacyApp(record).getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // 手动提升若实际抢占旧执行，同样是 human steer；自动 drain 不产生此标记。
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(attachments ? { attachments } : {}),
      });
      // 旧 fake app/兼容命令可能不返回 admission receipt；真实 app 已在 Core admission
      // 处完成 started 校验。只有明确 queued/rejected 才能判定 promotion 未启动。
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
    }
    startAdmitted = true;
    const removed = await legacyApp(record).removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // no-op compact 可能在 promoting 项删除前就完成；它的 ready hook 此时看见的
      // 仍是 dispatch=promoting，无法继续消费下一条 typed intent。删除后再过一次 mutation
      // 边界可关闭这个竞态；正常慢 compact 因 active controller 存在不会重复 drain。
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      legacyApp(record).runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // start 一旦 admitted 就不能 release，否则 remove 异常时另一端会重复执行；此时保持
    // promoting 供显式 resync/故障处理。start 前失败则安全回滚到 queued。
    if (queueItemReserved && !startAdmitted) {
      await legacyApp(record).releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};
