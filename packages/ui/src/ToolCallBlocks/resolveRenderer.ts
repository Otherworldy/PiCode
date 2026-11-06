// ============================================================
// 工具卡 renderer 注册表：tool identity → 具体 renderer 组件
// ============================================================
// 从 ToolCallBlocks.tsx 拆出：这张表随工具种类线性增长，和 renderContext 装配叠在一处后
// ToolCallBlocks.tsx 越过 oxlint max-lines(400)（rows.ts → toolDisplay.ts 是同一先例）。
// 本文件只做纯分流，不含 JSX、不碰 context 装配，ToolCallBlocks.tsx 单向依赖它。

import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import { ChangesGroupToolCallBlock } from "@/ToolCallBlocks/renderers/changes-group.js";
import { ExploreToolCallBlock } from "@/ToolCallBlocks/renderers/explore.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { ExecuteGroupToolCallBlock } from "@/ToolCallBlocks/renderers/execute-group.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { CuaToolCallBlock, isCuaToolCall } from "@/ToolCallBlocks/renderers/cua.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { GoalToolCallBlock } from "@/ToolCallBlocks/renderers/goal.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { McpToolCallBlock, readMcpToolPresentation } from "@/ToolCallBlocks/renderers/mcp.js";
import * as PluginUi from "@/plugin-ui/index.js";
import { PlanGuidanceToolCallBlock } from "@/ToolCallBlocks/renderers/plan-guidance.js";
import { ReadToolCallBlock } from "@/ToolCallBlocks/renderers/read.js";
import { ReadSessionContextToolCallBlock } from "@/ToolCallBlocks/renderers/read-session-context.js";
import { RespondToCoordinatorToolCallBlock } from "@/ToolCallBlocks/renderers/respond-to-coordinator.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SendMessageToolCallBlock } from "@/ToolCallBlocks/renderers/send-message.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { SubagentToolCallBlock } from "@/ToolCallBlocks/renderers/subagent.js";
import { SwitchModeToolCallBlock } from "@/ToolCallBlocks/renderers/switch-mode.js";
import { TaskOutputToolCallBlock } from "@/ToolCallBlocks/renderers/task-output.js";
import { TaskStopToolCallBlock } from "@/ToolCallBlocks/renderers/task-stop.js";
import { TodoToolCallBlock } from "@/ToolCallBlocks/renderers/todo.js";
import { AskQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/ask-question.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { isSubagentDispatchToolCall } from "@/lib/subagentToolNames.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export function resolveToolCallRenderer(context: ToolCallBlockRenderContext) {
  if (context.toolCallNode.toolCall.kind === "changesGroup") {
    return ChangesGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "executeGroup") {
    return ExecuteGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "cuaGroup") {
    return CuaGroupToolCallBlock;
  }
  if (isCuaToolCall(context.toolCallNode.toolCall)) {
    return CuaToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  // 子智能体派发工具同样不在已知工具表里（identity 回 unknown → raw fallback 卡），
  // 但 wire 名和扳手图标不能直接给用户看；按名认领后仍是兜底卡面，只换摘要行文案与图标。
  if (isSubagentDispatchToolCall(context.toolCallNode.toolCall)) {
    return SubagentToolCallBlock;
  }

  // 宿主 Node REPL 也通过 MCP 注册，因此同样带有 mcp_tool presentation。
  // 通用 MCP 分流若先执行，会吞掉代码、错误栈和 artifact 等专用交互。
  // 先按可信 tool identity 保留 Node REPL renderer，再让其余 MCP 使用通用展示。
  if (identity.family === "node-repl") {
    return NodeReplToolCallBlock;
  }
  if (PluginUi.shouldRenderPluginUi(context)) return PluginUi.PluginUiToolCallBlock;
  if (readMcpToolPresentation(context)) {
    return McpToolCallBlock;
  }

  // 当前工具名已经是固定集合。继续用正则扫 kind/title 的话，
  // 会把 TodoWrite 里的 Write 当成文件写入。这里先解析固定 tool identity，再按 family 分流；
  // PiCode 历史投影的工具形态由 identity resolver 统一处理。
  switch (identity.family) {
    case "plan-guidance":
      return PlanGuidanceToolCallBlock;
    case "agent":
      return AgentToolCallBlock;
    case "todo":
      return TodoToolCallBlock;
    case "ask-user-question":
      return AskQuestionToolCallBlock;
    case "message":
      return identity.toolName === "RespondToCoordinator"
        ? RespondToCoordinatorToolCallBlock
        : SendMessageToolCallBlock;
    case "task-control":
      return identity.toolName === "TaskOutput" ? TaskOutputToolCallBlock : TaskStopToolCallBlock;
    case "skill":
      return SkillToolCallBlock;
    case "session-context":
      return ReadSessionContextToolCallBlock;
    case "file-read":
      return ReadToolCallBlock;
    case "file-write":
      return EditToolCallBlock;
    case "explore":
      return ExploreToolCallBlock;
    case "switch-mode":
      return SwitchModeToolCallBlock;
    case "search":
      return SearchToolCallBlock;
    case "shell":
      return ExecuteToolCallBlock;
    case "goal":
      return GoalToolCallBlock;
    default:
      return FallbackToolCallBlock;
  }
}
