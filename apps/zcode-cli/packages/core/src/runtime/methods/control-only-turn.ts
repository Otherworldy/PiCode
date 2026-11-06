import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  SyntheticUserMessageSource,
  TraceContext,
  TurnInputIntentMetadata,
} from "../deps.js";
import { buildUserContentFromTurn } from "../helpers/index.js";
import { realUserRuntimeMetadata } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";

/**
 * controlOnly 用户轮的公共边界（`/goal` 外部 query 使用）。
 *
 * 两条入口都不走普通 `executeTurn`，却都要落一条**用户可见、role=user** 的持久消息、把它喂进
 * runtime history（模型下一回合看得到）、再补一组无模型输出的完整 turn 边界
 * （`TurnStarted{executionKind:"controlOnly"}` + `TurnComplete{response:""}`）——否则 live
 * ProductProjection 收不到 TurnStarted，query 要等冷恢复才现身，且 0ms 控制轮会被 modelChange
 * marker 误显示成「已工作 1 秒」。这条消息**怎么落**与标题/后续副作用各由 `persistMessage`
 * 回调与 `afterTurnBoundary` 回调注入。
 */
export async function emitControlOnlyUserTurn(
  this: AgentRuntimeInternal,
  options: {
    messageId: MessageId;
    /** `ensureSessionPersisted` 的首输入标题种子（/goal 用规范化 objective，启动用工作流名）。 */
    titleInput: string;
    /** 进 runtime history 的可见文本（模型下一回合读它）。 */
    historyText: string;
    /** `TurnStarted.input`（旧客户端 / TUI 的降级呈现）。 */
    turnInput: string;
    traceContext: TraceContext;
    inputId?: string;
    inputSource?: SyntheticUserMessageSource;
    intent?: TurnInputIntentMetadata;
    /** 落这条 user message（真实或 synthetic）——两条路径的唯一实质差异。 */
    persistMessage: () => Promise<void>;
    /** 会话首次落库后、turnNumber 推进前的可选副作用（标题 sidecar 等）。 */
    afterTurnBoundary?: () => void;
  },
): Promise<void> {
  const { messageId, traceContext } = options;
  // /goal 入口可能早于首次 turn 写入 runtime history；如果先 addUser，
  // 后续 lazy context init 会重建 messageHistory 并冲掉这条真实用户 query。
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(options.titleInput, traceContext);
  // 这类入口本身不走普通 submitPrompt，但它承载的是用户真实意图。这里同时写入
  // runtime history 和 session store，让模型上下文、桌面 continuous、手机 replayable snapshot
  // 使用同一条可见用户意图。
  this.messageHistory.addUser(
    buildUserContentFromTurn(options.historyText, []),
    realUserRuntimeMetadata(),
  );
  await options.persistMessage();
  // 不进入 executeTurn 的入口过去只有 transcript 落库，live ProductProjection 收不到
  // TurnStarted，导致 query 必须等冷恢复才出现。这里为这条真实用户输入补一组无模型输出的完整
  // turn 边界；后续（goal continuation / 通知驱动回合）仍会另开 turn，不会生成第二个用户气泡。
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(traceContext, {
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input: options.turnInput,
        messageId,
        ...(options.inputId ? { inputId: options.inputId } : {}),
        // 可见 query 需要独立 turn 才能实时展示，但它本身不执行 Agent。缺少该状态
        // 时 modelChange marker 会让 UI 把 0ms 控制轮误显示成「已工作 1 秒」并短暂覆盖
        // session running/activeWorks。
        executionKind: "controlOnly",
        ...(options.inputSource ? { inputSource: options.inputSource } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
        resultType: "success",
        ...(options.inputId ? { inputId: options.inputId } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  options.afterTurnBoundary?.();
  this.turnNumber += 1;
  this.messageHistory.setCacheMiss();
}

export async function recordExternalUserPrompt(
  this: AgentRuntimeInternal,
  input: string,
  options?: {
    goalSummaryTargetID?: string;
    traceContext?: TraceContext;
    intent?: TurnInputIntentMetadata;
  },
): Promise<MessageId> {
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const canonicalInput = options?.intent?.text?.trim() || input;
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: canonicalInput,
    historyText: input,
    turnInput: input,
    traceContext,
    inputId: options?.intent?.sourceCommandId,
    intent: options?.intent,
    // /goal 命令本身不走普通 submitPrompt，但首次设置 goal 的 objective 是用户真实
    // query；自动续跑 reminder 仍由 runtime 标成 model-only。
    persistMessage: () =>
      this.persistUserPrompt(messageId, input, undefined, traceContext, {
        intent: options?.intent,
        sessionInputId: options?.intent?.queueItemId,
        executionKind: "controlOnly",
      }),
    afterTurnBoundary: () => {
      // 首条 query 必须在 turnNumber 仍为 0 时启动标题 sidecar，否则首轮 gate 会把
      // 它误判为后续 turn，只生成 goal summaryTitle 而保留 first_input session title。
      const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
        this,
        canonicalInput,
        messageId,
        traceContext,
        { goalSummaryTargetID: options?.goalSummaryTargetID },
      );
      if (!titleGenerationStarted && options?.goalSummaryTargetID) {
        maybeStartGoalSummaryTitleGeneration.call(
          this,
          canonicalInput,
          options.goalSummaryTargetID,
          { traceContext },
        );
      }
    },
  });
  return messageId;
}
