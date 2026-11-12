import type { ZCodePlanStep } from "@picode/shared";
import { planFromPlannotatorProgress } from "./conversationStatusPanelModel.js";

export interface ComposerTodoModel {
  steps: ZCodePlanStep[];
  completedCount: number;
  activeTitle: string;
  /** 头部状态点跟随的那一步；抽屉头用图形而不只是标题来表达“在跑”。 */
  activeStatus: ZCodePlanStep["status"];
}

/** 开关打开且当前快照能解析出 Plannotator 清单时，输入框上方才有抽屉。 */
export function buildComposerTodo(
  enabled: boolean,
  widgets: ReadonlyArray<{ key: string; lines: readonly string[] }> | null | undefined,
): ComposerTodoModel | null {
  if (!enabled) return null;
  const plan = planFromPlannotatorProgress(widgets);
  if (!plan) return null;
  const steps: ZCodePlanStep[] = plan.items.map((item) => ({
    id: item.id,
    title: item.content,
    status:
      item.status === "completed"
        ? "completed"
        : item.status === "inProgress"
          ? "in_progress"
          : "pending",
  }));
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const active =
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status !== "completed") ??
    steps.at(-1);
  return {
    steps,
    completedCount,
    activeTitle: active?.title ?? "",
    activeStatus: active?.status ?? "pending",
  };
}
