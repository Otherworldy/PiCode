const SUMMARY_KEYS = [
  "pattern",
  "query",
  "command",
  "cmd",
  "url",
  "path",
  "filePath",
  "file_path",
  "prompt",
  "name",
  "title",
] as const;

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** 未知工具没有专用标题时，用最能说明这次调用的那个参数。 */
export function summarizeUnknownToolInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    const clipped = clip(input);
    return clipped || undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const clipped = clip(value);
    if (clipped) return clipped;
  }
  return undefined;
}

/** 结果正文。对象只在没有文本字段时才格式化，避免把整张工具卡再打印一遍。 */
export function readUnknownToolResult(output: unknown): string | undefined {
  if (typeof output === "string") return output.trim() ? output : undefined;
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  if (typeof record.content === "string" && record.content.trim()) return record.content;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return undefined;
  }
}
