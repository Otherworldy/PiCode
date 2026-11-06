import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// 权限/后台命令组：resolveInteraction / cancelBackgroundWork。
// - resolveInteraction：前向命令收口反向请求（permission/AskUserQuestion），经
//   host.interactions（V4InteractionRegistry）投递给 broker 侧等待中的 deferred。
// - cancelBackgroundWork：直驱 core 的可选能力 cancelBackgroundTask（workId ≡ taskId）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX } from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * 能力不支持错误：会话 runtime 未实现可选能力时抛出（对照旧 server-operations.ts
 * cancelBackgroundTask 的 ProtocolRequestError -32031 语义）。v4 侧不再用 JSON-RPC
 * 错误码，改用带 reasonCode 的结构化 Error（fault 命名空间），网关据此收口 ACK。
 */
export class V4CapabilityUnsupportedError extends Error {
  readonly reasonCode = "fault.command.capabilityUnsupported";

  constructor(capability: string, sessionId: string) {
    super(`capability not supported by this session runtime: ${capability} (session ${sessionId})`);
    this.name = "V4CapabilityUnsupportedError";
  }
}

const CONFIRM_OPTION_IDS = new Set(["yes", "no", "allowOnce", "allowAlways", "deny"]);

function askSelection(answer: {
  optionId?: string;
  freeText?: string;
  content?: Record<string, unknown>;
}): string | undefined {
  if (answer.optionId) {
    return CONFIRM_OPTION_IDS.has(answer.optionId) ? undefined : answer.optionId;
  }
  if (answer.freeText) return answer.freeText;
  const content = answer.content;
  if (!content) return undefined;
  if (typeof content.answer === "string" && content.answer) return content.answer;
  const answers = content.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  const values = Object.values(answers).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return values.length === 1 ? values[0] : undefined;
}

function questionnaireContent(content: unknown): Record<string, unknown> | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const record = content as Record<string, unknown>;
  const answers = record.answers;
  const hasNamedAnswer =
    !!answers &&
    typeof answers === "object" &&
    !Array.isArray(answers) &&
    Object.keys(answers).length > 0;
  const hasIndexedAnswer = Object.entries(record).some(([key, value]) => {
    if (!/^answer_\d+$/.test(key)) return false;
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === "string" && value.length > 0;
  });
  return hasNamedAnswer || hasIndexedAnswer ? record : undefined;
}

/**
 * resolveInteraction：投递应答给等待中的反向请求（interaction-broker 的 race deferred）。
 *
 * 语义保真（勘查结论）：
 * - 未命中（delivered === false，交互已被应答/已注销/未知 id）按幂等成功收口，不抛错——
 *   多端先到先得，晚到应答是无害幂等操作，抛 failed 会误导客户端。
 * - 不做 requireRecord：晚到应答可能发生在会话已收口/删除之后，同样必须无害；
 *   登记表按 interactionId 全局寻址，不依赖 record 存在。
 */
async function resolveInteraction(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const hosted =
    envelope.sessionId === null
      ? undefined
      : (
          host.getRecord(envelope.sessionId)?.app as
            | {
                piHosted?: {
                  ui: {
                    respond: (r: {
                      id: string;
                      confirmed?: boolean;
                      value?: string;
                      cancelled?: boolean;
                      content?: Record<string, unknown>;
                    }) => boolean;
                  };
                  publishUi?: () => void;
                };
              }
            | undefined
        )?.piHosted;
  if (hosted) {
    const answer = payload.answer;
    const picked = askSelection(answer);
    const questionnaire = questionnaireContent(answer.content);
    if (
      answer.action === "cancel" ||
      answer.action === "decline" ||
      answer.optionId === "no" ||
      answer.optionId === "deny"
    ) {
      hosted.ui.respond({ id: payload.interactionId, cancelled: true });
    } else if (picked !== undefined) {
      // 问卷选项不能当成 confirm。丢掉原文后插件对不上选项，表现成用户取消。
      hosted.ui.respond({
        id: payload.interactionId,
        value: picked,
        ...(questionnaire ? { content: questionnaire } : {}),
      });
    } else if (questionnaire) {
      // 多题 ask 不能压成一个 value，否则问题和选项又缠回一段文本。
      hosted.ui.respond({ id: payload.interactionId, content: questionnaire });
    } else if (
      answer.action === "accept" ||
      answer.optionId === "yes" ||
      answer.optionId === "allowOnce" ||
      answer.optionId === "allowAlways"
    ) {
      hosted.ui.respond(
        answer.optionId === "allowAlways"
          ? { id: payload.interactionId, value: "allowAlways" }
          : { id: payload.interactionId, confirmed: true },
      );
    } else {
      hosted.ui.respond({
        id: payload.interactionId,
        value: answer.freeText ?? answer.optionId ?? "",
      });
    }
    hosted.publishUi?.();
  }
  const delivered =
    payload.answer.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
      ? ((await host.interactions?.resolveFullAccess(payload.interactionId, envelope.sessionId!)) ??
        false)
      : (host.interactions?.resolve(payload.interactionId, payload.answer) ?? false);
  if (!delivered) {
    host.logger?.info?.("v4 resolveInteraction no pending interaction (idempotent)", {
      event: "zcode_protocol.v4.interaction_already_resolved",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

async function snoozeInteractionAutoResolution(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
  const snoozed = (await host.interactions?.snoozeAutoResolution(payload.interactionId)) ?? false;
  if (!snoozed) {
    host.logger?.info?.("v4 snoozeInteractionAutoResolution no active countdown (idempotent)", {
      event: "zcode_protocol.v4.interaction_auto_resolution_already_snoozed",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

class V4WorkspaceHookReviewRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Workspace Hook review command rejected: ${reasonCode}`);
    this.name = "V4WorkspaceHookReviewRejectedError";
  }
}

async function respondWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["respondWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.respondWorkspaceHookReview(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function toggleWorkspaceHookReviewItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["toggleWorkspaceHookReviewItem"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.toggleWorkspaceHookReviewItem(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function revokeWorkspaceHookTrust(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["revokeWorkspaceHookTrust"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.revokeWorkspaceHookTrust(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

/**
 * 软门禁:按需开审核 flow。
 *
 * 用户点击「去审核」时调用。经 controller.requestReview → openOrReuseFlow +
 * superviseFlow。已有活跃 flow 时幂等复用。无 pending 项时为安全 no-op。
 */
async function requestWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["requestWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.requestWorkspaceHookReview({
    workspaceIdentity: payload.workspaceIdentity,
    bundleDigest: payload.bundleDigest,
  });
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

function requireWorkspaceHookReviewRecord(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  payloadSessionId: string,
) {
  if (envelope.sessionId !== payloadSessionId) {
    throw new V4WorkspaceHookReviewRejectedError("workspace_hooks_snapshot_mismatch");
  }
  return requireRecord(host, envelope.sessionId);
}

/**
 * cancelBackgroundWork 的业务拒绝：core 明确回「没有取消任何东西」（reason 在场）。
 *
 * 老 run 被冷回放误留在 running 时，详情页的 Cancel 可点，
 * 命令直达 core 却查无此任务（`background_task_not_found`）；旧 handler 把结构化结果整个丢掉、
 * 回 accepted，用户面前于是「点了没反应」。core 的 reason 是唯一权威，这里只做前缀搬运。
 */
class V4BackgroundWorkCancelRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, workId: string) {
    super(`background work ${workId} was not cancelled: ${reason}`);
    this.name = "V4BackgroundWorkCancelRejectedError";
    this.reasonCode = `${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${reason.replace(/^background_task_/, "")}`;
  }
}

/**
 * cancelBackgroundWork：workId ≡ 旧 taskId 直传 core。
 * - cancelBackgroundTask 是 ZCodeApp 可选能力：不存在 → 抛能力不支持（见上）。
 * - core 回 `reason`（不存在 / 已终结 / 类型不支持）→ 以 `fault.command.backgroundWorkCancelRejected.<reason>`
 *   的 reasonCode 回 ACK；真取消了或返回值缺席（stub 宿主）才是 accepted。
 * - 不需要 legacy 广播：BackgroundTask*（Started/Updated/Completed）生命周期事件
 *   由 core 直接 emit，v4 投影（product-projection backgroundWorks）自收口——
 *   对照旧 op 的 afterStateMutation("background_task_cancelled")，v4 面无此义务。
 */
async function cancelBackgroundWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelBackgroundTask) {
    throw new V4CapabilityUnsupportedError("cancelBackgroundTask", record.app.sessionId);
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.cancelBackgroundTask(payload.workId);
  if (result?.reason !== undefined) {
    throw new V4BackgroundWorkCancelRejectedError(result.reason, payload.workId);
  }
  return undefined;
}

class V4RunningSubagentModelRejectedError extends Error {
  readonly reasonCode = "fault.command.runningSubagentModelRejected.not_found";

  constructor() {
    super("running subagent not found");
    this.name = "V4RunningSubagentModelRejectedError";
  }
}

/** 只改这一次活着的子会话，不写设置，也不停父会话。 */
async function setRunningSubagentModel(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setRunningSubagentModel"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.setRunningSubagentModel) {
    throw new V4CapabilityUnsupportedError("setRunningSubagentModel", record.app.sessionId);
  }
  const ok = await record.app.setRunningSubagentModel({
    childSessionId: payload.childSessionId,
    provider: payload.provider,
    model: payload.model,
    thought: payload.thought,
  });
  if (!ok) throw new V4RunningSubagentModelRejectedError();
  return undefined;
}

export const interactionBackgroundHandlers = {
  resolveInteraction,
  respondWorkspaceHookReview,
  toggleWorkspaceHookReviewItem,
  revokeWorkspaceHookTrust,
  requestWorkspaceHookReview,
  snoozeInteractionAutoResolution,
  cancelBackgroundWork,
  setRunningSubagentModel,
};
