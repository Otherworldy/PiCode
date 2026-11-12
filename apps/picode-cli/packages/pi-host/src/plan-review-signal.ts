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

/** annotate 审查的三种收口。计划审查、代码审查各有自己的前缀，不在这里。 */
const ANNOTATION_NOTICE_PREFIXES = [
  "Annotation session closed.",
  "Annotation closed (no feedback).",
  "Annotation approved.",
];

/** 用户在审查页点了 Done：批准，或 Done 但没有可提交的批注。直接关页面不在其中。 */
const ANNOTATION_DONE_PREFIXES = ["Annotation approved.", "Annotation closed (no feedback)."];

const REVIEW_DISMISS_PREFIXES = [
  ...ANNOTATION_NOTICE_PREFIXES,
  "Code review session closed.",
  "Code review closed (no feedback).",
  "Message approved.",
  "Plan review session was closed before a decision.",
];

/** 审查页关掉或没有新批注。工作中收到口，但不另开一轮。 */
export function isPlannotatorReviewDismissed(message: string): boolean {
  return REVIEW_DISMISS_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** 这次通知是 annotate 审查收口，含用户直接关掉页面。 */
export function isAnnotationReviewNotice(message: string): boolean {
  return ANNOTATION_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** 用户点了 Done（批准或空批注）。UI 设计模式靠这条退场，直接关页面不算。 */
export function isAnnotationReviewDone(message: string): boolean {
  return ANNOTATION_DONE_PREFIXES.some((prefix) => message.startsWith(prefix));
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
