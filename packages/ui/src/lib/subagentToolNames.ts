/**
 * 子智能体派发工具（`picode_subagent`）的按名识别。
 *
 * 它不在 `packages/shared` 的 `ZCODE_KNOWN_TOOL_NAMES` 里：`resolveToolCallIdentity` 只会回
 * unknown，工具卡因此落到 raw fallback renderer。这里单独认领工具名，让兜底卡的摘要行把
 * wire 名（`Picode_subagent`）换成用户可读的「子智能体」，并换成子智能体图标。
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  // 照 workflowToolNames.ts 的同款归一：抹掉大小写与分隔符，
  // `picode_subagent` / `picodeSubagent` 两种 wire 写法都命中。
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

/** 归一后的 `picode_subagent`，也就是下划线被抹掉的名字。 */
const SUBAGENT_DISPATCH_TOOL_TOKEN = normalizeToolToken("picode_subagent");

interface SubagentToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

export function isSubagentDispatchToolCall(source: SubagentToolNameSource): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === SUBAGENT_DISPATCH_TOOL_TOKEN,
  );
}
