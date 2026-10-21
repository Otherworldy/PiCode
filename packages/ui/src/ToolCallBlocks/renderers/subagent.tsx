import { BotIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { FallbackToolCallBlock } from "./fallback.js";

/** 子智能体派发工具与 Agent 卡共用同一枚图标，兜底卡不再显示通用扳手。 */
const SUBAGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * `picode_subagent` 没有专用卡面：详情、结果和展开交互沿用兜底卡，
 * 摘要行只保留「子智能体」文案与子智能体图标（不再显示 wire 名、扳手图标和兜底的「工具调用」）。
 */
export function SubagentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  return (
    <FallbackToolCallBlock
      {...context}
      iconOverride={SUBAGENT_TOOL_ICON}
      kindLabelOverride={intl.formatMessage({ id: "chat.toolCall.kind.subagent" })}
      primaryTextOverride={null}
    />
  );
}
