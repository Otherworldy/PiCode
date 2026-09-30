import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";

const IMAGE_CHARS = 4800;

type Part = {
  source: ZCodeContextUsageBreakdownItem["source"];
  tokens: number;
};

export type PiContextUsage = {
  used: number;
  max: number;
  breakdown: ZCodeContextUsageBreakdownItem[];
};

type PiContextSession = {
  systemPrompt: string;
  messages: readonly unknown[];
  model?: { contextWindow?: number };
  getActiveToolNames(): string[];
  getAllTools(): Array<{ name: string; description?: string; parameters?: unknown }>;
  getContextUsage(): { tokens: number | null; contextWindow?: number; percent: number | null } | undefined;
  resourceLoader: { getSkills(): { skills: Skill[] } };
};

function tokensOfText(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function tokensOf(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "string") return tokensOfText(value);
  try {
    return tokensOfText(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function contentChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return tokensOf(value) * 4;
  let chars = 0;
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: string };
    if (record.type === "text" && record.text) chars += record.text.length;
    else if (record.type === "image") chars += IMAGE_CHARS;
  }
  return chars;
}

/** 只算确实嵌进系统提示的片段，避免源文件再加一遍。 */
function embeddedTokens(prompt: string, chunk: string): number {
  if (!chunk || !prompt.includes(chunk)) return 0;
  return tokensOfText(chunk);
}

function memoryTokens(systemPrompt: string): number {
  let total = 0;
  for (const match of systemPrompt.matchAll(
    /<project_instructions\b[^>]*>\n([\s\S]*?)\n<\/project_instructions>/g,
  )) {
    total += tokensOfText(match[1] ?? "");
  }
  return total;
}

function capParts(parts: Part[], target: number, fixedPrefix: number): Part[] {
  const fixed = parts.slice(0, fixedPrefix);
  const variable = parts.slice(fixedPrefix);
  const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
  const variableTarget = Math.max(0, target - fixedTokens);
  const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
  if (estimated <= variableTarget || estimated === 0) return parts;
  if (variableTarget === 0) return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
  let previous = 0;
  let cumulative = 0;
  const capped = variable.map((part, index) => {
    cumulative += part.tokens;
    const next =
      index === variable.length - 1
        ? variableTarget
        : Math.round((cumulative / estimated) * variableTarget);
    const tokens = next - previous;
    previous = next;
    return { ...part, tokens };
  });
  return [...fixed, ...capped];
}

function resolveUsed(
  reported: number | null,
  percent: number | null,
  estimated: number,
  contextWindow: number,
): number {
  const fromPercent =
    percent !== null && contextWindow > 0 ? Math.round((percent / 100) * contextWindow) : undefined;
  let resolved = reported ?? fromPercent ?? estimated;
  if (reported !== null && fromPercent !== undefined) {
    const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
    if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
  }
  if (estimated > 0 && resolved < estimated * 0.25) return estimated;
  return resolved;
}

function addMessage(message: Record<string, unknown>, into: { tools: number; context: number }): void {
  if (message.role === "system") return;
  if (message.role === "toolResult" || message.role === "bashExecution") {
    const chars =
      message.role === "bashExecution"
        ? String(message.command ?? "").length + String(message.output ?? "").length
        : contentChars(message.content);
    into.tools += Math.ceil(chars / 4);
    return;
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const part = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
      if (part.type === "toolCall") into.context += tokensOf(part.name) + tokensOf(part.arguments);
      else if (part.type === "text") into.context += tokensOf(part.text);
      else if (part.type === "thinking") into.context += tokensOf(part.thinking);
    }
    return;
  }
  const summary = typeof message.summary === "string" ? message.summary : undefined;
  into.context += summary ? tokensOfText(summary) : Math.ceil(contentChars(message.content) / 4);
}

/** 按 pi-cc `/context` 的六类估算，再缩放到 Pi 的上下文总量。 */
export function readPiContextUsage(
  session: PiContextSession,
  formatSkills: (skills: Skill[], fileReadTool?: "read" | "bash") => string,
): PiContextUsage | null {
  const reported = session.getContextUsage();
  const contextWindow = reported?.contextWindow ?? session.model?.contextWindow ?? 0;
  if (contextWindow <= 0) return null;
  const systemPrompt = session.systemPrompt;
  const active = session.getActiveToolNames();
  const selected = new Set(active);
  const fileTool = (["read", "bash"] as const).find((name) => selected.has(name));
  const skillsText = fileTool
    ? formatSkills(session.resourceLoader.getSkills().skills, fileTool).trim()
    : "";
  const memory = memoryTokens(systemPrompt);
  const skills = embeddedTokens(systemPrompt, skillsText);
  let toolTokens = 0;
  for (const tool of session.getAllTools()) {
    if (!selected.has(tool.name)) continue;
    toolTokens += tokensOf({ name: tool.name, description: tool.description, parameters: tool.parameters });
  }
  const counts = { tools: 0, context: 0 };
  for (const message of session.messages) {
    if (message && typeof message === "object") addMessage(message as Record<string, unknown>, counts);
  }
  const parts: Part[] = [
    { source: "system_prompt", tokens: Math.max(0, tokensOfText(systemPrompt) - memory - skills) },
    { source: "memory", tokens: memory },
    { source: "skills", tokens: skills },
    { source: "tools", tokens: toolTokens },
    { source: "tool_results", tokens: counts.tools },
    { source: "messages", tokens: counts.context },
  ];
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  const fixed = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
  const used = Math.max(
    resolveUsed(reported?.tokens ?? null, reported?.percent ?? null, estimated, contextWindow),
    fixed,
  );
  const capped = capParts(parts, used, 4);
  const attributed = capped.reduce((sum, part) => sum + part.tokens, 0);
  const breakdown = [...capped, { source: "other" as const, tokens: Math.max(0, used - attributed) }]
    .filter((part) => part.tokens > 0)
    .map((part) => ({ source: part.source, chars: part.tokens, tokens: part.tokens }));
  return { used, max: contextWindow, breakdown };
}
