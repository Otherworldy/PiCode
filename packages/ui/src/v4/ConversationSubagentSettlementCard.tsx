import { BotIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { AgentNameText } from "@/ToolCallBlocks/renderers/agent.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

/** 与 Agent 工具卡同一枚图标，读者一眼认出这是子智能体而不是普通正文。 */
const SETTLEMENT_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * 后台子代理的结算通知卡片。
 *
 * 这条消息是发给模型的结果副本，但它同样是给人看的状态行：整段正文铺在时间线上
 * 会把一轮对话切碎。这里按工具卡的形状画——摘要行报角色与状态，报告正文收在
 * 展开区，右边能给子会话详情的入口，和 Agent 工具卡的用法一致。
 *
 * 正文只取 `settlement.text`：整条消息开头那两行（角色、childSessionId）已经由
 * 摘要行表达，重复渲染只是噪音。
 */
export function ConversationSubagentSettlementCard({
  row,
  context,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const settlement = row.subagentSettlement;
  const agent = settlement?.agent ?? "";
  const status = settlement?.status ?? "success";
  const childSessionId = settlement?.childSessionId;
  const body = settlement?.text.trim() ?? "";
  const parentSessionId = context.sessionId ?? undefined;
  const canOpen = Boolean(childSessionId && parentSessionId && context.onOpenSubagentSession);
  const primaryText = useMemo(
    () => <AgentNameText color={resolveSubagentColorFromName(agent)} name={agent} />,
    [agent],
  );
  const openChildSession = useCallback(() => {
    if (!childSessionId || !parentSessionId) return;
    context.onOpenSubagentSession?.({
      rootSessionId: context.rootSessionId ?? parentSessionId,
      parentSessionId,
      childSessionId,
      subagentType: agent,
      // 标题存 wire 名，侧边 tab 渲染时再翻：切语言后已有的 tab 也跟着变。
      title: agent,
    });
  }, [agent, childSessionId, context, parentSessionId]);
  // 摘要行本身留给展开/收起：报告才是这一行的主要内容。
  // 右侧子会话用角色名做入口，点它才不会顺手把卡片折叠掉。
  const primaryWithAction = useMemo(
    () =>
      canOpen && childSessionId ? (
        <button
          type="button"
          data-testid={testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId)}
          aria-label={intl.formatMessage({
            id: "chat.toolCall.agent.openInSidePane",
          })}
          title={intl.formatMessage({
            id: "chat.toolCall.agent.openInSidePane",
          })}
          className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={(event) => {
            // 摘要行是 CollapsibleTrigger：不拦住就会边开侧栏边折叠。
            event.preventDefault();
            event.stopPropagation();
            openChildSession();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {primaryText}
        </button>
      ) : (
        primaryText
      ),
    [canOpen, childSessionId, intl, openChildSession, primaryText],
  );
  const renderContent = useCallback(
    () =>
      body ? (
        <div className="ml-2 border-border border-l pl-3.5">
          <MessageResponse
            className="min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={context.workspacePath}
            workspaceHomePath={context.workspaceHomePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            sessionId={context.sessionId ?? undefined}
            readAttachment={context.readAttachment}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenExternalUrl={context.onOpenBrowserUrl}
          >
            {body}
          </MessageResponse>
        </div>
      ) : null,
    [
      body,
      context.codePreviewSettings,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.readAttachment,
      context.sessionId,
      context.theme,
      context.workspaceHomePath,
      context.workspaceIdentity,
      context.workspacePath,
      context.workspaceRemoteSessionId,
    ],
  );

  return (
    <ToolLayout
      toolId={`subagent-settlement:${row.rowId}`}
      icon={SETTLEMENT_ICON}
      // 没有报告正文时不给展开箭头，避免点开一张空卡。
      canToggle={body.length > 0}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.kind.subagent" })}
      primaryText={primaryWithAction}
      statusLabel={intl.formatMessage({
        id: `subagentDirectory.status.${status}`,
      })}
      showStatusLabel
      showFailureStatus={status === "failed"}
      title={agent}
      renderContent={renderContent}
    />
  );
}
