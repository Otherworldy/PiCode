import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";

/** 工作块或正文。正文是块边界：它不进限高容器，否则读正文也要在框里滚。 */
export type ConversationAssistantWorkRenderChunk =
  | {
      kind: "text";
      key: string;
      item: Extract<ConversationAssistantWorkRenderItem, { kind: "row" }>;
    }
  | {
      kind: "work";
      key: string;
      items: ConversationAssistantWorkRenderItem[];
    };

/**
 * 把渲染项切成「正文」和「连续工作项」两类。连续工作项才交给限高容器：
 * 一轮里十几个工具连续跑时，这里是一块；中间夹了正文就变成两块，各自滚。
 */
export function chunkAssistantWorkRenderItems(
  items: readonly ConversationAssistantWorkRenderItem[],
): ConversationAssistantWorkRenderChunk[] {
  const chunks: ConversationAssistantWorkRenderChunk[] = [];
  let pending: ConversationAssistantWorkRenderItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    chunks.push({ kind: "work", key: `work:${pending[0]!.key}`, items: pending });
    pending = [];
  };
  for (const item of items) {
    if (item.kind === "row" && item.row.kind === "assistantText") {
      flush();
      chunks.push({ kind: "text", key: item.key, item });
      continue;
    }
    pending.push(item);
  }
  flush();
  return chunks;
}
