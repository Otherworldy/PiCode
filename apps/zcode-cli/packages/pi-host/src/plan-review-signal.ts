import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const PLAN_SUBMIT_TOOL = "plannotator_submit_plan";

/** 插件把审查决定用 sendUserMessage 送回来。source 是 extension，原文要能对上。 */
export function createPlanReviewSignalExtension(
  onDecision: (text: string) => void,
): InlineExtension {
  return {
    name: "picode-plan-review",
    hidden: true,
    factory(pi) {
      pi.on("input", (event) => {
        if (event.source !== "extension") return;
        const text = event.text.trim();
        if (text) onDecision(event.text);
      });
    },
  };
}

export function isOpenPlanReviewResult(
  toolName: string,
  result: { details?: unknown } | undefined,
  isError: boolean | undefined,
): boolean {
  if (isError || toolName !== PLAN_SUBMIT_TOOL) return false;
  const details = result?.details;
  if (!details || typeof details !== "object") return false;
  return (details as { pending?: unknown }).pending === true;
}

/** 对上一条就拿走。审查期间用户自己发的消息对不上，审查轮继续显示工作中。 */
export function takePlanDecision(pending: string[], text: string): boolean {
  const index = pending.indexOf(text);
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

export function textOfMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}
