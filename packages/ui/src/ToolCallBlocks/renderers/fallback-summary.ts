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

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/** 未知工具没有专用标题时，用最能说明这次调用的那个参数。 */
export function summarizeUnknownToolInput(input: unknown): string | undefined {
  if (typeof input === "string" && !input.trim().startsWith("{")) {
    const clipped = clip(input);
    return clipped || undefined;
  }
  const record = asRecord(input);
  if (!record) return undefined;
  const action = typeof record.action === "string" ? record.action.trim() : "";
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const clipped = clip(value);
    if (!clipped) continue;
    // process 这类工具靠 action 区分 start/output，单看 command 不够。
    return action && action !== clipped ? clip(`${action} ${clipped}`) : clipped;
  }
  return action ? clip(action) : undefined;
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
