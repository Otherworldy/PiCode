import type { PiHostEvent } from "./types.js";

export type PiJsonlSummary = {
  title: string;
  createdAt: number;
  lastActivityAt: number;
  cwd?: string;
  lastAssistantPreview?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function linesOf(content: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of content.split(/\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (record) out.push(record);
    } catch {
      // skip malformed jsonl line
    }
  }
  return out;
}

function timeMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function clip(text: string, max: number): string {
  const compact = text.trim().replace(/\s+/gu, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function isUserRole(role: unknown): boolean {
  return role === "user";
}

function isAssistantRole(role: unknown): boolean {
  return role === "assistant";
}

function isToolResultRole(role: unknown): boolean {
  return role === "toolResult" || role === "tool";
}

function toolCallsOf(content: unknown): Array<{ id: string; name: string; args?: unknown }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; args?: unknown }> = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    if (record.type !== "toolCall" && record.type !== "tool_call") continue;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "unknown";
    if (!id) continue;
    calls.push({ id, name, args: record.arguments });
  }
  return calls;
}

export function readPiJsonl(content: string): {
  summary: PiJsonlSummary | null;
  events: PiHostEvent[];
} {
  const entries = linesOf(content);
  const now = Date.now();
  let createdAt: number | undefined;
  let lastActivityAt: number | undefined;
  let cwd: string | undefined;
  let namedTitle: string | undefined;
  let firstUser = "";
  let lastAssistant = "";
  const events: PiHostEvent[] = [];
  let inTurn = false;

  const beginTurn = () => {
    if (inTurn) return;
    events.push({ type: "agent_start" });
    inTurn = true;
  };
  const endTurn = () => {
    if (!inTurn) return;
    events.push({ type: "agent_settled" });
    inTurn = false;
  };

  for (const entry of entries) {
    const type = entry.type;
    const timestamp = timeMs(entry.timestamp, 0);
    if (timestamp > 0) {
      createdAt ??= timestamp;
      lastActivityAt = timestamp;
    }
    if (type === "session") {
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      continue;
    }
    if (type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      namedTitle = clip(entry.name, 60);
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const role = message.role;
    if (isUserRole(role)) {
      const text = messageText(message.content);
      if (!firstUser && text.trim()) firstUser = text;
      endTurn();
      beginTurn();
      events.push({
        type: "message_start",
        message: { role: "user", content: text, id: typeof entry.id === "string" ? entry.id : undefined },
      });
      continue;
    }
    if (isAssistantRole(role)) {
      beginTurn();
      const id = typeof entry.id === "string" ? entry.id : undefined;
      events.push({ type: "message_start", message: { role: "assistant", id } });
      for (const call of toolCallsOf(message.content)) {
        events.push({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.args,
        });
      }
      const text = messageText(message.content);
      if (text.trim()) lastAssistant = text;
      events.push({
        type: "message_end",
        message: { role: "assistant", content: message.content, id },
      });
      continue;
    }
    if (isToolResultRole(role)) {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      if (!toolCallId) continue;
      events.push({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        result: { content: [{ type: "text", text: messageText(message.content) }] },
        isError: message.isError === true,
      });
    }
  }
  endTurn();

  if (!firstUser && !namedTitle) return { summary: null, events: [] };
  const title = namedTitle ?? clip(firstUser, 60);
  return {
    summary: {
      title,
      createdAt: createdAt ?? now,
      lastActivityAt: lastActivityAt ?? createdAt ?? now,
      ...(cwd ? { cwd } : {}),
      ...(lastAssistant ? { lastAssistantPreview: clip(lastAssistant, 120) } : {}),
    },
    events,
  };
}

export function summarizePiJsonl(content: string): PiJsonlSummary | null {
  return readPiJsonl(content).summary;
}

export function replayPiJsonl(content: string): PiHostEvent[] {
  return readPiJsonl(content).events;
}
