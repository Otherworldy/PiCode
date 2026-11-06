import { ModelRequestSessionType, type SessionTaskType } from "@zcode/contracts";

/** 模型请求按宿主 session 做粗分类。 */
export function resolveModelRequestSessionTypeFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRequestSessionType {
  if (taskType === "subagent_child") return ModelRequestSessionType.Subagent;
  return ModelRequestSessionType.Main;
}
