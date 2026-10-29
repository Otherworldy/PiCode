import { BotIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { readSubagentBackgrounded, readSubagentDispatchRole } from "@/lib/subagentToolNames.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { AgentNameText } from "./agent.js";
import { FallbackToolCallBlock } from "./fallback.js";

/** 子智能体派发工具与 Agent 卡共用同一枚图标，兜底卡不再显示通用扳手。 */
const SUBAGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * `picode_subagent` 没有专用卡面：详情、结果和展开交互沿用兜底卡，
 * 摘要行只保留「子智能体」、派发的角色名和子智能体图标（不显示 wire 名、扳手图标和兜底的「工具调用」）。
 */
export function SubagentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const role = readSubagentDispatchRole(context.toolCallNode.toolCall);
  const backgrounded = readSubagentBackgrounded(context.toolCallNode.toolCall);
  return (
    <FallbackToolCallBlock
      {...context}
      iconOverride={SUBAGENT_TOOL_ICON}
      kindLabelOverride={intl.formatMessage({ id: "chat.toolCall.kind.subagent" })}
      kindDetail={
        backgrounded ? (
          <Badge
            variant="outline"
            data-subagent-background="true"
            className="align-baseline text-ui-xs"
          >
            {intl.formatMessage({ id: "chat.toolCall.subagent.background" })}
          </Badge>
        ) : undefined
      }
      primaryTextOverride={
        role ? <AgentNameText color={resolveSubagentColorFromName(role)} name={role} /> : null
      }
    />
  );
}
