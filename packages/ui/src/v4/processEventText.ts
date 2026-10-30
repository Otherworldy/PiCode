import type { AssistantTextRow, ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * Pi process 插件的状态通知（`pi.sendMessage` 发出的 custom message）。
 * 它借 `assistantText` 行承载，但不是模型正文：任何「这是不是正文」的判定都必须先过这里，
 * 否则通知会切开工作折叠、被当成最终答复挂上复制/分叉动作，还会混进分享文案。
 */
export function isProcessEventText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<process_event") && trimmed.includes("</process_event>");
}

/** 正文判定：assistantText 行减去 process 通知。 */
export function isAssistantBodyTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText" && !isProcessEventText(row.text);
}

/** 通知里给读者看的那一行。整段 XML 不是给人读的。 */
export function processEventSummary(text: string): string | null {
  if (!isProcessEventText(text)) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  if (summary) return summary;
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("<"));
  return line ?? null;
}
