import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

const THOUGHT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 辅助生成用最低可用思考档，避免思考把提交信息吃掉。 */
export function lowestPiThought(model: {
  thinkingLevelMap?: Record<string, unknown>;
}): ModelThinkingLevel {
  const map = model.thinkingLevelMap;
  if (!map) return "off";
  for (const level of THOUGHT_ORDER) {
    if (map[level] != null) return level;
  }
  return "off";
}

export function piAssistantText(message: {
  stopReason: string;
  errorMessage?: string;
  content: readonly { type: string; text?: string; thinking?: string }[];
}): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage?.trim() || "模型请求失败。");
  }
  const text = message.content
    .filter((block) => block.type === "text" && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n")
    .trim();
  if (text) return text;
  const thinking = message.content
    .filter((block) => block.type === "thinking" && block.thinking?.trim())
    .map((block) => block.thinking!.trim())
    .join("\n")
    .trim();
  if (thinking) return thinking;
  throw new Error("模型响应缺少文本内容。");
}
