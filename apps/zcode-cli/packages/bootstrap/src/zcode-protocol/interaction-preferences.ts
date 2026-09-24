import { zcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
 */
export async function updateInteractionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(false);

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: false,
    snoozedInteractionCount,
  };
}
