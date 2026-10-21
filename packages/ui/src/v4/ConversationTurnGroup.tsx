/* eslint-disable max-lines -- turn group 需要在同一处维护普通 assistant 与后台结果的严格行序，拆分会重复 actions/preview/tail 协议。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { Fragment, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  TID_V4_ROW,
  testId,
  type ZCodeApiRetryStatus,
} from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  WorkflowNotificationMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ResumeHereButton, type ResumeHereChoice } from "@/v4/ResumeHereMenu.js";
import {
  CronCreateAutomationCard,
  isCronAutomationCardToolCall,
  readCronCreateAutomationSummary,
  type CronCreateAutomationSummary,
} from "@/ToolCallBlocks/renderers/cron-create.js";
import {
  isOffPeakCreateToolCall,
  OffPeakCreateTaskCard,
  readOffPeakCreateTaskSummary,
  type OffPeakCreateTaskSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import { chunkAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkChunks.js";
import { ConversationCappedScroll } from "@/v4/ConversationCappedScroll.js";
import {
  buildAssistantWorkRenderItems,
  ENABLE_CHANGES_TOOL_CALL_GROUPING,
  ENABLE_CUA_TOOL_CALL_GROUPING,
  ENABLE_EXPLORE_TOOL_CALL_GROUPING,
  ENABLE_TERMINAL_TOOL_CALL_GROUPING,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import {
  activeWorkingFoldIndex,
  isSeparatelyFoldedFlowItem,
  lastFoldIndex,
  splitCompactStatusRows,
} from "@/v4/conversationTurnFlowItems.js";
import { resolveWorkChunkStatusFacts } from "@/v4/conversationTurnWorkSegments.js";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";
import { resolveWorkActivity, type WorkActivityState } from "@/v4/workChunkActivity.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { inferReasoningDurations } from "@/v4/reasoningDuration.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

interface ConversationTurnGroupProps {
  unit: ConversationTurnRenderUnit;
  /** 仅由 Timeline 注入给当前 live turn；历史 turn 永远不携带运行时 retry。 */
  apiRetry?: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 分享选择阶段在正文左侧显示本轮勾选入口。 */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
}

interface CronAutomationTurnCard {
  rowId: number;
  toolCallId: string;
  automation: CronCreateAutomationSummary;
}

interface OffPeakTurnCard {
  rowId: number;
  toolCallId: string;
  task: OffPeakCreateTaskSummary;
}

const MIN_VISIBLE_API_RETRY_ATTEMPT = 1;

function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts 包含首次请求，而展示口径是重试次数；直接展示会把
  // 默认 10 次重试写成 1/11。
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

function TurnChatLoadingSlot({
  apiRetry,
  eligible,
  durationMs,
  toolCount = 0,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
  /** 本轮净工时；运行中由 projection 的 ticker 每秒刷新。 */
  durationMs?: number;
  /** 整轮累计的工具调用数，与工时同口径。 */
  toolCount?: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const [failuresOpen, setFailuresOpen] = useState(false);
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // 第一次重试就要告诉用户，否则长时间退避看起来仍是普通「工作中」。
  const visibleRetryStatus =
    retryStatus && retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT ? retryStatus : null;
  const failures = apiRetry?.failures ?? [];
  if (!visibleRetryStatus && !eligible) return null;
  if (visibleRetryStatus && failures.length > 0) {
    return (
      <div data-zcode-chat-loading-slot="true" className="min-h-5 text-ui-base">
        <button
          type="button"
          className="text-left"
          onClick={() => setFailuresOpen((open) => !open)}
        >
          <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
        </button>
        {failuresOpen ? (
          <ul className="mt-1 space-y-1 pl-1 text-foreground-subtle">
            {failures.map((failure) => (
              <li key={failure.attempt}>
                {intl.formatMessage(
                  { id: "chat.apiRetry.failureAttempt" },
                  { attempt: failure.attempt },
                )}
                {" · "}
                {failure.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const durationLabel = formatConversationWorkDuration(durationMs, intl, locale);
  // 运行中的工时和次数只在这一行报：时长是本轮净工时（已扣权限审批和提问的等待），
  // 次数按整轮累计；工作块自己的标题跑着时只报当前动作。
  // 「工作中」不再写成文字：转圈图标本身就够表达在跑，前面再顶一个词只是冗余。
  const statsLabel =
    toolCount > 0
      ? durationLabel === null
        ? intl.formatMessage({ id: "chat.history.foldedTools" }, { count: toolCount })
        : intl.formatMessage(
            { id: "chat.loading.workStats" },
            { duration: durationLabel, count: toolCount },
          )
      : durationLabel === null
        ? intl.formatMessage({ id: "chat.loading.working" })
        : intl.formatMessage({ id: "chat.loading.workingFor" }, { duration: durationLabel });
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // 文字走中性的扫光（与工作块标题同一套色阶），图标跟它同色系、只是实色转圈。
        // 扫光是 background-clip: text，不能包住图标，否则图标也跟着变透明。
        <span
          className="inline-flex items-center gap-1.5 text-ui-base text-foreground-subtle"
          data-testid={TID_CHAT_LOADING}
        >
          <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          <span className="zcode-working-shimmer">{statsLabel}</span>
        </span>
      )}
    </div>
  );
}

function toolResumeMenu(
  rows: readonly { rowId: number; toolCallId: string; toolName: string }[],
  onResumeHere: ConversationRowRenderContext["onResumeHere"],
  toolId: string,
) {
  if (!onResumeHere) return null;
  const row = rows.find((candidate) => candidate.toolCallId === toolId);
  if (!row) return null;
  return (
    <ResumeHereButton
      rowId={row.rowId}
      onPick={(choice: ResumeHereChoice) =>
        onResumeHere({
          entryId: row.toolCallId,
          role: "tool",
          text: row.toolName,
          ...choice,
        })
      }
    />
  );
}

function ConversationExploreGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "exploreGroup" }>;
  context: ConversationRowRenderContext;
}) {
  const resumeMenuForToolId = useCallback(
    (toolId: string) => toolResumeMenu(item.rows, context.onResumeHere, toolId),
    [context.onResumeHere, item.rows],
  );
  // explore 分组行已经处在 turn 容器的统一边距内，单独再加 px-4
  // 会让同一串工具调用有的内缩、有的不内缩。
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        resumeMenuForToolId={resumeMenuForToolId}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
      />
    </div>
  );
}

function ConversationToolGroupRow({
  item,
  context,
}: {
  item: Extract<
    ConversationAssistantWorkRenderItem,
    { kind: "cuaGroup" | "executeGroup" | "changesGroup" }
  >;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.kind === "cuaGroup"
        ? item.events.filter(
            (event) =>
              event.kind !== "reasoning" ||
              isConversationReasoningRowVisible(event.row.rowId, context),
          )
        : undefined,
    [context, item],
  );
  const resumeMenuForToolId = useCallback(
    (toolId: string) =>
      item.kind === "cuaGroup" ? null : toolResumeMenu(item.rows, context.onResumeHere, toolId),
    [context.onResumeHere, item],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        resumeMenuForToolId={resumeMenuForToolId}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        // history/background 兼容路径只传虚拟父节点时，已被分组投影消费的
        // Assistant message / reasoning 没有交给 renderer，展开后会永久丢失。
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={item.kind === "cuaGroup" ? renderAssistantMessage : undefined}
        renderCuaReasoning={item.kind === "cuaGroup" ? renderReasoning : undefined}
      />
    </div>
  );
}

function ConversationCuaGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationTurnFlowItem, { kind: "cuaGroup" }>;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  const visibleCuaEvents = useMemo(
    () =>
      item.events.filter(
        (event) =>
          event.kind !== "reasoning" || isConversationReasoningRowVisible(event.row.rowId, context),
      ),
    [context, item.events],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={renderAssistantMessage}
        renderCuaReasoning={renderReasoning}
      />
    </div>
  );
}

function ConversationAssistantWorkItems({
  rows,
  context,
  stageTailIsRunning = false,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  /** running turn 的正文可能暂时落在 history renderer，仍需隐藏特化协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: {
    chunkKey: string;
    open: boolean;
  };
}) {
  if (historyContainer && !historyContainer.open) {
    // 折叠时不挂工具和正文。长会话里这些节点才是滚动卡顿的来源，展开后再建。
    return (
      <CollapsibleContent
        data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
        data-history-open="false"
      />
    );
  }
  return (
    <OpenConversationAssistantWorkItems
      rows={rows}
      context={context}
      stageTailIsRunning={stageTailIsRunning}
      assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      historyContainer={historyContainer}
    />
  );
}

function OpenConversationAssistantWorkItems({
  rows,
  context,
  stageTailIsRunning = false,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: {
    chunkKey: string;
    open: boolean;
  };
}) {
  const showReasoning = context.messageStreamShowReasoning === true;
  const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        {
          messageStreamShowReasoning: showReasoning,
          ...(firstReasoningRowId !== undefined
            ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
            : {}),
        },
        {
          stageTailIsRunning,
          enableCuaGrouping: ENABLE_CUA_TOOL_CALL_GROUPING,
          enableExploreGrouping:
            context.toolGroupingExploreEnabled ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING,
          enableTerminalGrouping:
            context.toolGroupingTerminalEnabled ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING,
          enableChangesGrouping:
            context.toolGroupingChangesEnabled ?? ENABLE_CHANGES_TOOL_CALL_GROUPING,
        },
      ),
    [
      context.toolGroupingChangesEnabled,
      context.toolGroupingExploreEnabled,
      context.toolGroupingTerminalEnabled,
      stageTailIsRunning,
      firstReasoningRowId,
      rows,
      showReasoning,
    ],
  );
  const chunkList = useMemo(() => chunkAssistantWorkRenderItems(items), [items]);

  // history 外壳不能在这层投影前创建：当 CUA 消费原 message
  // 或运行中 shell 被延迟分类时，会留下 pt-5 和空的 gap-4 容器。只有确认
  // 内层存在可渲染项后才创建 CollapsibleContent，让外壳与内容一起消失。
  if (items.length === 0) {
    return null;
  }

  // 连续工作项（工具/explore/reasoning）统一 gap-4 组容器（对齐旧版 tool-call-group），
  // 取代继承父级 gap-5/gap-2 + 每行 py-2 的双重且不一致的间距。
  //
  // 正文把工作块切开：一条连续工具链装进限高容器，正文留在外面正常排版。
  // 工具只用一两张卡时不套框，免得为了两行内容多出一条滚动条。
  const renderWorkItem = (item: ConversationAssistantWorkRenderItem) =>
    item.kind === "row" ? (
      <ConversationTurnRow
        key={item.key}
        row={item.row}
        context={context}
        hideAssistantActions={false}
        assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      />
    ) : item.kind === "agentToolCall" ? (
      <ConversationAgentToolCallRow key={item.key} item={item} context={context} />
    ) : item.kind === "exploreGroup" ? (
      <ConversationExploreGroupRow key={item.key} item={item} context={context} />
    ) : (
      <ConversationToolGroupRow key={item.key} item={item} context={context} />
    );

  // 只有尾部那一块算「还在跑」：`stageTailIsRunning` 是整轮级别的，
  // 直接下发给每块会让已结束的块也跟着跳到底部。
  const runningChunkKey = stageTailIsRunning ? chunkList[chunkList.length - 1]?.key : undefined;

  const content = (
    <div className="flex flex-col gap-4">
      {chunkList.map((chunk) =>
        chunk.kind === "text" ? (
          <ConversationTurnRow
            key={chunk.key}
            row={chunk.item.row}
            context={context}
            hideAssistantActions
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        ) : chunk.items.length === 1 ? (
          renderWorkItem(chunk.items[0]!)
        ) : (
          <ConversationCappedScroll key={chunk.key} running={chunk.key === runningChunkKey}>
            {chunk.items.map(renderWorkItem)}
          </ConversationCappedScroll>
        ),
      )}
    </div>
  );

  if (!historyContainer) {
    return content;
  }

  return (
    <CollapsibleContent
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
      data-history-open={String(historyContainer.open)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

function CollapsibleAssistantWorkItems({
  rows,
  historyContainer,
  ...rest
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: { chunkKey: string; open: boolean };
}) {
  const groups = splitCompactStatusRows(rows);
  if (groups.length === 1 && groups[0]?.pinned !== true) {
    return (
      <ConversationAssistantWorkItems rows={rows} historyContainer={historyContainer} {...rest} />
    );
  }
  return groups.map((group) => (
    <ConversationAssistantWorkItems
      key={group.rows[0]!.rowId}
      rows={group.rows}
      {...rest}
      historyContainer={group.pinned ? undefined : historyContainer}
    />
  ));
}

function resolveCronAutomationTurnCards(
  rows: readonly AssistantWorkRow[],
): CronAutomationTurnCard[] {
  let cards: CronAutomationTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }

    const normalizedToolName = row.toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalizedToolName === "crondelete") {
      const deletedAutomationId = readCronDeleteAutomationId(row);
      if (deletedAutomationId) {
        // 只累计本轮成功的 Create/Update 会忽略后续 CronDelete，导致已经
        // 撤销的中间结果仍被提升成轮尾成功卡片。
        cards = cards.filter((card) => card.automation.automationId !== deletedAutomationId);
      }
      continue;
    }

    const node = toolCallRowToLegacyNode(row);
    if (!isCronAutomationCardToolCall(node.toolCall)) {
      continue;
    }

    const automation = readCronCreateAutomationSummary(node.toolCall);
    if (!automation) {
      continue;
    }

    if (automation.automationId) {
      cards = cards.filter((card) => card.automation.automationId !== automation.automationId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      automation,
    });
  }

  return cards;
}

// 只收本轮 status==="success" 的 OffPeakCreate；同 id 重复输出保留最新一次。
// 刻意不复用 resolveCronAutomationTurnCards——那套带 CronDelete 撤销过滤语义，闲时无对应工具。
function resolveOffPeakTurnCards(rows: readonly AssistantWorkRow[]): OffPeakTurnCard[] {
  let cards: OffPeakTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }
    const node = toolCallRowToLegacyNode(row);
    if (!isOffPeakCreateToolCall(node.toolCall)) {
      continue;
    }
    const task = readOffPeakCreateTaskSummary(node.toolCall);
    if (!task) {
      continue;
    }
    if (task.offPeakTaskId) {
      cards = cards.filter((card) => card.task.offPeakTaskId !== task.offPeakTaskId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      task,
    });
  }

  return cards;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readCronDeleteAutomationId(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): string | undefined {
  for (const candidate of [row.output?.text, row.input, row.inputText]) {
    const record = parseJsonRecord(candidate);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function CronAutomationTurnCards({
  cards,
  context,
}: {
  cards: readonly CronAutomationTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <CronCreateAutomationCard
          key={`${card.rowId}:${card.toolCallId}`}
          automation={card.automation}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function OffPeakTurnCards({
  cards,
  context,
}: {
  cards: readonly OffPeakTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <OffPeakCreateTaskCard
          key={`${card.rowId}:${card.toolCallId}`}
          task={card.task}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function foldedWorkLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: ReturnType<typeof useZCodeIntl>["locale"],
  toolCount: number,
  durationMs: number | undefined,
): string | null {
  if (toolCount <= 0) return null;
  const duration = formatConversationWorkDuration(durationMs, intl, locale);
  return duration
    ? intl.formatMessage({ id: "chat.history.foldedWork" }, { count: toolCount, duration })
    : intl.formatMessage({ id: "chat.history.foldedTools" }, { count: toolCount });
}

/**
 * 一个工作块的折叠标题。
 *
 * 还在工作的那一块报当前动作（「正在思考」「正在运行命令」），统计数字（工时、次数）
 * 只由轮尾那行报。已经结束的块只报自己的跨度，否则整轮的第一块会顶着累计工时
 * 一直走秒，看起来像计时器停不下来。
 */
function WorkChunkStatus({
  chunkKey,
  segment,
  open,
  isWorkingChunk,
  isTailChunk,
  process = false,
  plain = false,
  activity,
  toolCount = 0,
  chunkDurationMs,
}: {
  chunkKey: string;
  segment: ConversationTurnWorkSegment;
  open: boolean;
  /** 整轮当前正在工作的块：运行中它报当前动作，不报统计。 */
  isWorkingChunk: boolean;
  /** 本段的最后一块：中断文案挂在这里。 */
  isTailChunk: boolean;
  /** 首块以外的历史块，带 process 标记。 */
  process?: boolean;
  /** 没有可折叠的工具块时只显示时长，不挂触发器。 */
  plain?: boolean;
  /** 运行中报的动作；缺省时只说「工作中」。 */
  activity?: WorkActivityState | null;
  toolCount?: number;
  chunkDurationMs?: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const facts = resolveWorkChunkStatusFacts({
    ...(segment.workStatus?.state === undefined ? {} : { segmentState: segment.workStatus.state }),
    ...(segment.workStatus?.durationMs === undefined
      ? {}
      : { segmentDurationMs: segment.workStatus.durationMs }),
    isWorkingChunk,
    isTailChunk,
    toolCount,
    ...(chunkDurationMs === undefined ? {} : { chunkDurationMs }),
    ...(plain ? { plain } : {}),
  });
  const durationLabel = formatConversationWorkDuration(facts.durationMs, intl, locale);
  const folded = foldedWorkLabel(intl, locale, facts.toolCount, facts.durationMs);
  let label: string;
  if (facts.running) {
    label =
      activity == null
        ? intl.formatMessage({ id: "chat.loading.working" })
        : intl.formatMessage({
            id: activity.preparing
              ? `chat.workChunk.preparing.${activity.activity}`
              : `chat.workChunk.activity.${activity.activity}`,
          });
  } else if (facts.interrupted) {
    label = intl.formatMessage({ id: "chat.history.stopped" });
  } else if (folded !== null) {
    label = folded;
  } else if (durationLabel !== null) {
    label = intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel });
  } else if (process) {
    label = intl.formatMessage({ id: "chat.history.process" });
  } else {
    label = intl.formatMessage({ id: "chat.history.worked" });
  }
  const button = (
    <button
      type="button"
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, chunkKey)}
      data-history-open={String(open)}
      {...(process ? { "data-history-role": "process" } : {})}
      className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
    >
      <span className={cn("truncate", facts.running && "zcode-working-shimmer")}>{label}</span>
      {plain ? null : (
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
            open ? "rotate-90" : "rotate-0",
          )}
        />
      )}
    </button>
  );

  return (
    <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
      {plain ? button : <CollapsibleTrigger asChild>{button}</CollapsibleTrigger>}
    </div>
  );
}

function countToolCallRows(rows: readonly { kind: string }[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind === "toolCall") count += 1;
  }
  return count;
}

function chunkWorkStats(
  rows: readonly {
    kind: string;
    createdAt?: number;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
  }[],
): {
  toolCount: number;
  durationMs?: number;
} {
  const toolCount = countToolCallRows(rows);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const start = row.startedAt ?? row.createdAt;
    let end = row.endedAt ?? start;
    if (row.kind === "reasoning" && start !== undefined && row.durationMs !== undefined) {
      end = Math.max(end ?? start, start + row.durationMs);
    }
    if (start !== undefined && start < min) min = start;
    if (end !== undefined && end > max) max = end;
  }
  const span = Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
  // 不足 1 秒多半是同一条消息上的时间戳，不能显示成「工作 1 秒」。
  return span >= 1000 ? { toolCount, durationMs: span } : { toolCount };
}

function WorkChunkFold({
  chunkKey,
  defaultOpen,
  process,
  segment,
  isWorkingChunk,
  isTailChunk,
  activity,
  toolCount,
  chunkDurationMs,
  children,
}: {
  chunkKey: string;
  defaultOpen: boolean;
  process: boolean;
  segment: ConversationTurnWorkSegment;
  isWorkingChunk: boolean;
  isTailChunk: boolean;
  toolCount: number;
  activity?: WorkActivityState | null;
  chunkDurationMs?: number;
  children: (open: boolean) => ReactNode;
}) {
  const [storedOpen, setStoredOpen] = useState(defaultOpen);
  useEffect(() => {
    setStoredOpen(defaultOpen);
  }, [defaultOpen, chunkKey]);
  // 运行中的块也能收起：默认展开，箭头随时可点（口径照 dsh 的组标题）。
  return (
    <Collapsible open={storedOpen} onOpenChange={setStoredOpen}>
      <WorkChunkStatus
        chunkKey={chunkKey}
        segment={segment}
        open={storedOpen}
        isWorkingChunk={isWorkingChunk}
        isTailChunk={isTailChunk}
        process={process}
        activity={activity}
        toolCount={toolCount}
        {...(chunkDurationMs === undefined ? {} : { chunkDurationMs })}
      />
      {children(storedOpen)}
    </Collapsible>
  );
}

function ConversationWorkSegmentFlow({
  segment,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  canForkLatestAssistant,
  canRetryLatestAssistant,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  segment: ConversationTurnWorkSegment;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantPreviewCards: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  canForkLatestAssistant: boolean;
  canRetryLatestAssistant: boolean;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  const shouldShowHistoryStatus = segment.workStatus !== undefined;
  const hasFold = segment.flowItems.some(isSeparatelyFoldedFlowItem);
  const activeFoldIndex = activeWorkingFoldIndex(
    segment.flowItems,
    segment.assistantHistoryDefaultOpen,
  );
  // 中断文案挂在本段最后一个工具块上，与这块后面还有没有正文无关。
  const tailFoldIndex = lastFoldIndex(segment.flowItems);
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (item) => item.kind !== "userInput",
  );
  let foldIndex = 0;

  const renderWorkItems = (
    rows: typeof segment.assistantHistoryRows,
    stageTailIsRunning: boolean,
    historyContainer?: { chunkKey: string; open: boolean },
  ) => (
    <CollapsibleAssistantWorkItems
      rows={rows}
      context={context}
      stageTailIsRunning={stageTailIsRunning}
      assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      {...(historyContainer ? { historyContainer } : {})}
    />
  );

  return (
    // 外层不用 gap：Radix 收起动画量的是 content 高度，兄弟间距放在外边距上。
    <div className="history-message flex flex-col [&>*+*]:mt-5">
      {segment.flowItems.map((item, index) => {
        const stageTailIsRunning =
          segment.workStatus?.state === "running" &&
          index === segment.flowItems.length - 1 &&
          (item.kind === "assistantHistory" || item.kind === "assistantWork");
        const showPlainStatus =
          shouldShowHistoryStatus && !hasFold && index === firstAssistantFlowItemIndex;
        const itemKey =
          item.kind === "userInput" || item.kind === "assistantText"
            ? `${item.kind}:${item.row.rowId}`
            : `${item.kind}:${item.rows[0]?.rowId ?? index}`;
        let content: React.ReactNode;

        if (item.kind === "userInput") {
          const userRow = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            />
          );
          content =
            shareSelectionToggle && item.row.rowId === shareSelectionRowId ? (
              <div className="relative">
                {shareSelectionToggle}
                {userRow}
              </div>
            ) : (
              userRow
            );
        } else if (item.kind === "assistantText") {
          content = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onFork={item.latest && canForkLatestAssistant ? onFork : undefined}
              onRetry={item.latest && canRetryLatestAssistant ? onRetry : undefined}
              hideAssistantActions={!item.latest}
              // 操作栏就在正文下方渲染，不再 defer 到轮尾：两处都画会出现两颗分叉。
              deferAssistantActions={false}
              assistantCopyText={item.latest ? assistantCopyText : undefined}
              assistantPreviewCards={item.latest ? assistantPreviewCards : undefined}
              assistantPreviewCardsAutoOpenKey={
                item.latest ? assistantPreviewCardsAutoOpenKey : undefined
              }
              assistantCodeCommentCards={item.latest ? assistantCodeCommentCards : undefined}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        } else if (
          isSeparatelyFoldedFlowItem(item) &&
          (item.kind === "assistantHistory" ||
            item.kind === "assistantWork" ||
            item.kind === "cuaGroup")
        ) {
          // 正文把工具和思考切成独立块：每块报自己的工具次数和跨度，
          // 整轮工时只挂在当前工作的那一块上。
          const process = foldIndex > 0;
          const chunkKey = process ? `${segment.key}:chunk-${foldIndex}` : segment.key;
          foldIndex += 1;
          const stats = chunkWorkStats(item.rows);
          content = (
            <WorkChunkFold
              chunkKey={chunkKey}
              defaultOpen={index === activeFoldIndex}
              process={process}
              segment={segment}
              isWorkingChunk={index === activeFoldIndex}
              isTailChunk={index === tailFoldIndex}
              activity={resolveWorkActivity(item.rows, {
                stageRunning: index === activeFoldIndex,
              })}
              toolCount={stats.toolCount}
              {...(stats.durationMs !== undefined ? { chunkDurationMs: stats.durationMs } : {})}
            >
              {(open) =>
                item.kind === "cuaGroup" ? (
                  <CollapsibleContent
                    data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, chunkKey)}
                    data-history-open={String(open)}
                  >
                    <div className="pt-5">
                      <ConversationCuaGroupRow item={item} context={context} />
                    </div>
                  </CollapsibleContent>
                ) : (
                  renderWorkItems(item.rows, stageTailIsRunning, { chunkKey, open })
                )
              }
            </WorkChunkFold>
          );
        } else if (item.kind === "cuaGroup") {
          content = <ConversationCuaGroupRow item={item} context={context} />;
        } else {
          // 压缩分隔线和折叠区外的插件卡不进工作块。
          content = renderWorkItems(item.rows, stageTailIsRunning);
        }

        return (
          <Fragment key={itemKey}>
            {showPlainStatus ? (
              <WorkChunkStatus
                chunkKey={segment.key}
                segment={segment}
                open={false}
                // 没有工具块可切时，这一行就是整轮唯一的工作状态：跑着就报当前动作。
                isWorkingChunk={segment.workStatus?.state === "running"}
                isTailChunk
                activity={resolveWorkActivity(segment.assistantWorkRows, {
                  stageRunning: segment.workStatus?.state === "running",
                })}
                plain
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {shouldShowHistoryStatus && !hasFold && firstAssistantFlowItemIndex < 0 ? (
        <WorkChunkStatus
          chunkKey={segment.key}
          segment={segment}
          open={false}
          isWorkingChunk={segment.workStatus?.state === "running"}
          isTailChunk
          activity={resolveWorkActivity(segment.assistantWorkRows, {
            stageRunning: segment.workStatus?.state === "running",
          })}
          plain
        />
      ) : null}
    </div>
  );
}

function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  shareSelectionToggle,
  shareSelectionRowId,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  shareSelectionToggle?: ReactNode;
  shareSelectionRowId?: number;
}) {
  // 产品语义：可见正文或工具不代表主轮已经结束；ChatLoading 跟随最后一轮
  // running 生命周期，但等待用户回答/授权时由交互 UI 独占进度反馈。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          stageTailIsRunning={unit.isRunning}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot
          apiRetry={apiRetry}
          eligible={showLoading}
          durationMs={unit.workStatus?.durationMs}
          toolCount={countToolCallRows(unit.assistantWorkRows)}
        />
      </div>
    );
  }

  const projectedWorkSegments = unit.workSegments ?? [];
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // 兼容仍直接构造/覆写旧 render unit 的调用方；真实 guide 多段不走这个分支。
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // 即使恢复了 guide 的 row 全序，也不能让所有 history chunk 共享同一个
  // Collapsible。accepted guide 现在由 CLI workSegments 定界，每段组件自行维护折叠状态。
  return (
    <div className="flex flex-col gap-5">
      {workSegments.map((segment) => (
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRowId}
        />
      ))}
      <TurnChatLoadingSlot
        apiRetry={apiRetry}
        eligible={showLoading}
        durationMs={unit.workStatus?.durationMs}
        toolCount={countToolCallRows(unit.assistantWorkRows)}
      />
    </div>
  );
}

/**
 * 能撑起「后台结果头」这套渲染的来源白名单。
 *
 * 这里刻意仍是白名单而不是直接信任 schema：`originMeta` 在 userInputRow 上是 optional，
 * 跨版本仍可能出现第四个取值，而没见过的来源拿不到合适的标题语义，退回普通 assistant
 * 分支比谎报一个标题好。
 *
 * workflow run 的 `backgroundSource` 是 `"workflow"`（CLI 侧
 * `background-tasks.ts` 在 CreateWorkflow 终态上报，title 由 `workflowTaskSubject` 铸造），
 * 原本落在白名单外，于是一条 run 跑完之后那一轮**既没有标题、也退化成按工时折叠的普通
 * assistant 段落**——后台结果分组整个消失。标题不需要本地化：它由 CLI 权威给出，
 * bash / subagent 同样直接透传。
 */
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * 该轮是否以 workflow 通知卡（ToolLayout 行）开头。
 *
 * `ConversationBackgroundResultWork` 据此决定渲染通知行还是裸标题行。
 */
function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowNotificationMeta | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  return originMeta?.backgroundSource === "workflow" ? originMeta.workflowNotification : undefined;
}

function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  const hasHistory = unit.assistantHistoryRows.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // 后台结果已经由独立唤醒轮总结过；复用普通 assistant 的工时折叠
  // 会显示不准确的分段耗时，并让一段短总结产生没有意义的收起状态。
  //
  // workflow run 的 workflow 通知带结构化载荷时改渲染既有工具卡语法的通知行（替换裸标题行）；
  // 载荷缺席（批量轮、旧 transcript、bash/subagent）→ 原样退回标题行。
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // 打开 run 详情：宿主注入 onOpenWorkflowRun + 联查到 toolCallId 才可点；冷恢复查不到时
  // 展开体内不渲染链接。toolCallId 走投影/journal 联查表，与 CreateWorkflow 工具卡同一条打开路径。
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // 产物 chip → 全尺寸查看 tab。门比 `openWorkflowRun` 松一格：产物 tab 只需要
  // (parentSessionId, runId, artifactId)，**不需要** toolCallId——它不画因果图，也就不必
  // 回到那条 CreateWorkflow 工具行。冷恢复后联查不到 toolCallId 的通知行因此仍能开产物。
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // 载荷里那一枚的 `contentType`（终态通知才有产物清单）：宿主据它决定 html 产物
          // 直接开浏览器 tab 还是开产物 tab，所以这里带得到就带上。载荷刻意不带 `sourcePath`
          // （状态帧体积），宿主缺席时自己查 journal 补。
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
        />
      ) : (
        <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      {hasHistory ? (
        <div className="flex flex-col gap-2">
          <ConversationAssistantWorkItems
            rows={unit.assistantHistoryRows}
            context={context}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        </div>
      ) : null}
      {latestAssistantTextRow ? (
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot
        apiRetry={apiRetry}
        eligible={showLoading}
        durationMs={unit.workStatus?.durationMs}
        toolCount={countToolCallRows(unit.assistantWorkRows)}
      />
    </div>
  );
}

function ConversationTurnGroupImpl({
  unit,
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  shareSelection,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  const reasoningDurationMsByRowId = useMemo(
    () => inferReasoningDurations(unit.renderRows, unit.header?.startedAt),
    [unit.header?.startedAt, unit.renderRows],
  );
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      reasoningDurationMsByRowId,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
      // 操作栏挂在正文行内部，拿不到轮级事实；用量、hook 行和轮 id 只能由这里注入。
      ...(unit.header?.usage === undefined ? {} : { turnUsage: unit.header.usage }),
      ...(unit.hookInvocations.length === 0 ? {} : { turnHookInvocations: unit.hookInvocations }),
      turnId: unit.turnId,
      ...(onFeedbackChange === undefined ? {} : { onFeedbackChange }),
    }),
    [
      context,
      firstReasoningRowId,
      reasoningDurationMsByRowId,
      unit.header?.usage,
      unit.hookInvocations,
      unit.turnId,
      onFeedbackChange,
    ],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  const assistantRawCopyText = useMemo(
    () => resolveAssistantCopyText(unit),
    [unit.assistantTextRows, unit.assistantWorkRows, unit.latestAssistantTextRow],
  );
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // 卡片与 zcode-file-citation 的预览卡片保持一致：流式期间只投影正文，
      // 只有终态 row 才生成卡片，避免运行中卡片先出现又因模型续写而回滚。
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 上方已是工具摘要；下方运行卡在联接到 run 后立即显示，不能再等主代理回复结束。
  // 依赖联接表保持实时更新，并由解析器按 runId 去重。直接启动轮
  // 的 run 卡也从这里出：那一轮没有用户气泡、没有助手内容，run 卡就是它的全部呈现。
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
      }),
    [unit, workflowGraphByToolCallId, workflowRunByRunId, workflowRunByToolCallId],
  );
  // 完成卡：主代理消化 completed 通知的那一轮，轮尾落卡。
  // 同一条门（轮结束）；联接只认 byRunId——通知轮里没有 CreateWorkflow 行可按 toolCallId 联。
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  const hasHookActions =
    // Hook action 与 copy/feedback/fork 共用 turn eligibility；
    // timelineOnly 维护 turn（compact/modelChange marker 轮）即使带历史遗留的
    // didExecute=true Hook row 也不得露出图标，否则 /compact 轮会凭 SessionStart
    // Hook 误挂出一个不可解释的操作栏。
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    if (unit.header?.actions?.canRewindFiles !== true) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [unit.header?.actions?.canRewindFiles, unit.header?.fileChanges, unit.isRunning]);

  const shareSelectionRows = shareSelection
    ? unit.visibleUserInputs.filter(
        (row) => row.origin === "realUser" && shareSelection.eligibleRowIds.has(row.rowId),
      )
    : [];
  // 一个 turn 可以有多条 realUser 输入（steer/排队消息），而这里只渲染一个
  // turn 级 checkbox。用 every() 折叠成布尔值会让部分选中显示为"未选中"，
  // 用户看到未选中却点一下让计数跳 2。半选必须显式呈现为 indeterminate。
  const shareSelectionSelectedCount = shareSelection
    ? shareSelectionRows.filter((row) => shareSelection.selectedRowIds.has(row.rowId)).length
    : 0;
  const shareSelectionChecked: boolean | "indeterminate" =
    shareSelection === undefined || shareSelectionRows.length === 0
      ? false
      : shareSelectionSelectedCount === shareSelectionRows.length
        ? true
        : shareSelectionSelectedCount === 0
          ? false
          : "indeterminate";
  const shareSelectionToggle =
    shareSelectionRows.length > 0 ? (
      <div
        data-conversation-share-turn-toggle="true"
        data-conversation-share-turn-toggle-state={
          shareSelectionChecked === true
            ? "selected"
            : shareSelectionChecked === "indeterminate"
              ? "partial"
              : "unselected"
        }
        className="absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center"
      >
        <label className="flex size-8 cursor-pointer items-center justify-center">
          <Checkbox
            checked={shareSelectionChecked}
            aria-label={
              shareSelectionRows[0]?.text ||
              intl.formatMessage({ id: "conversationShare.partial.panelLabel" })
            }
            onCheckedChange={(checked) => {
              if (!shareSelection) return;
              // Radix 从 indeterminate 点击后给出 true，半选状态因此会补齐整个 turn。
              if (checked === true) {
                for (const row of shareSelectionRows) {
                  if (!shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              } else if (checked === false) {
                for (const row of shareSelectionRows) {
                  if (shareSelection.selectedRowIds.has(row.rowId))
                    shareSelection.onToggle(row.rowId);
                }
              }
            }}
            checkIconStrokeWidth={1.33}
            className="size-4 rounded-sm border-foreground bg-transparent data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=indeterminate]:border-foreground data-[state=indeterminate]:bg-foreground data-[state=indeterminate]:text-background"
          />
        </label>
      </div>
    ) : null;

  return (
    <section
      data-turn-id={unit.turnId}
      data-turn-key={unit.key}
      // 轮间只留一档间距：pt-14 会和上轮 pb-5 叠成大块空白，完全去掉又会贴在一起。
      className="relative mx-auto flex w-full flex-col gap-5 px-4 pt-8 pb-5 @md/conversation:px-6"
    >
      {unit.leadingBoundaryRows.map((row) => (
        <ConversationTurnRow
          key={`${row.rowId}:${row.entityId ?? ""}`}
          row={row}
          context={context}
        />
      ))}
      {hasAssistantTurnContent ? (
        // deferAssistantActions 后工具栏被移到文件 summary 之后，
        // 之前 hover group 只包住工具栏自己，导致必须悬停到不可见按钮位置才出现。
        // 这里把 assistant work、summary 和工具栏放进同一轮 hover 容器，对齐旧版。
        <div className="group/assistant-turn relative flex w-full flex-col gap-5">
          {backgroundResultTitle ? (
            <>
              {visibleUserRows.map((row) =>
                shareSelectionToggle && row.rowId === shareSelectionRows[0]?.rowId ? (
                  <div className="relative" key={`${row.rowId}:${row.entityId ?? ""}`}>
                    {shareSelectionToggle}
                    <ConversationTurnRow
                      row={row}
                      context={context}
                      onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                    />
                  </div>
                ) : (
                  <ConversationTurnRow
                    key={`${row.rowId}:${row.entityId ?? ""}`}
                    row={row}
                    context={context}
                    onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                    editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                  />
                ),
              )}
              <ConversationBackgroundResultWork
                unit={unit}
                apiRetry={apiRetry}
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                title={backgroundResultTitle}
                assistantCopyText={assistantCopyText}
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            </>
          ) : (
            <ConversationTurnFlow
              unit={unit}
              apiRetry={apiRetry}
              context={assistantRowContext}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={onRetry}
              onEdit={onEdit}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
              shareSelectionToggle={shareSelectionToggle}
              shareSelectionRowId={shareSelectionRows[0]?.rowId}
              assistantCopyText={assistantCopyText}
              assistantCodeCommentCards={assistantCodeCommentCards}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              assistantPreviewCardsAutoOpenKey={
                assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                  ? assistantPreviewPptxAutoOpenTarget.key
                  : undefined
              }
            />
          )}
          {/* 完成卡：这一轮消化的那条 run 做了什么、花了多少，紧跟最后一段正文。 */}
          {workflowTurnCompletion === undefined ? null : (
            <ConversationWorkflowCompletion
              completion={workflowTurnCompletion}
              context={context}
              turnKey={unit.key}
            />
          )}
          {/* 轮尾摘要：这一轮留下在跑的 run，排在完成卡之后、其余轮尾块之前。 */}
          <ConversationWorkflowDigests
            context={context}
            digests={workflowTurnDigests}
            turnKey={unit.key}
          />
          {/* CronCreate/CronUpdate 工具本身仍按普通工具行展示；成功卡片属于整轮
              完成后的结果摘要，必须等回复结束再跟随最终 assistant 正文收尾。 */}
          <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
          <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
          {!isOfficeMode && unit.header?.fileChanges ? (
            <ConversationFileSummaryPanel header={unit.header} context={context} />
          ) : null}
          {unit.browserTurnEndRows.length > 0 ? (
            // 自动截图表达轮次结束时页面最终状态；放在 assistant work 内会
            // 穿插到 Website 预览和 file diff 摘要之间。它应是操作栏之前的最后一个内容块。
            <ConversationAssistantWorkItems
              rows={unit.browserTurnEndRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            // turnTailBoundary 之前虽然从工作历史中拆出，却仍在 flow 内渲染，
            // 使 CronCreate、文件 summary 与操作栏看起来落在 fork 分割线之后。boundary
            // 必须统一收在全部 turn-local 附属 UI 之后，才是真正的 logical turn 结尾。
            <ConversationAssistantWorkItems
              rows={unit.assistantTailRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {/* 正文行的操作栏已经在正文下方渲染，这里不再重复一遍 —— 两处都画就会出现
              两颗分叉按钮。只有「本轮没有可渲染正文、但有 hook 执行」时才在轮尾补一个。 */}
          {!canRenderAssistantActions && hasHookActions ? (
            <MessageActions>
              <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
            </MessageActions>
          ) : null}
        </div>
      ) : (
        <ConversationTurnFlow
          unit={unit}
          apiRetry={apiRetry}
          context={assistantRowContext}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          shareSelectionToggle={shareSelectionToggle}
          shareSelectionRowId={shareSelectionRows[0]?.rowId}
          assistantCopyText={assistantCopyText}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      )}
    </section>
  );
}

export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
