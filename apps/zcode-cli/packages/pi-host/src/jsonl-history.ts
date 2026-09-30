import type { PiHostEvent } from "./types.js";

export type PiJsonlSummary = {
  title: string;
  createdAt: number;
  lastActivityAt: number;
  cwd?: string;
  lastAssistantPreview?: string;
  sessionId?: string;
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

function activeEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.type !== "session") byId.set(entry.id, entry);
  }
  let leafId: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && typeof entry.id === "string" && entry.type !== "session") {
      leafId = entry.id;
      break;
    }
  }
  if (!leafId) return entries;
  const linked = entries.some((entry) => typeof entry.parentId === "string" && entry.parentId);
  if (!linked) return entries;
  const keep = new Set<string>();
  let current = byId.get(leafId);
  while (current && typeof current.id === "string" && !keep.has(current.id)) {
    keep.add(current.id);
    const parentId = current.parentId;
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return entries.filter(
    (entry) => entry.type === "session" || (typeof entry.id === "string" && keep.has(entry.id)),
  );
}

export function readPiJsonl(content: string): {
  summary: PiJsonlSummary | null;
  events: PiHostEvent[];
} {
  const entries = activeEntries(linesOf(content));
  const now = Date.now();
  let firstAt = 0;
  let headerAt = 0;
  let lastMessageAt = 0;
  let cwd: string | undefined;
  let namedTitle: string | undefined;
  let sessionId: string | undefined;
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
    if (timestamp > 0 && !firstAt) firstAt = timestamp;
    if (type === "session") {
      // 分叉文件的消息时间是原会话的。创建时间用 header，不能被旧消息盖回去。
      if (timestamp > 0) headerAt = timestamp;
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      if (typeof entry.id === "string" && entry.id) sessionId = entry.id;
      continue;
    }
    if (type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      namedTitle = clip(entry.name, 60);
      continue;
    }
    if (type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
      events.push({ type: "branch_summary", summary: entry.summary });
      continue;
    }
    if (type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
      endTurn();
      events.push({ type: "compaction_start", reason: "manual" });
      events.push({
        type: "compaction_end",
        reason: "manual",
        result: {
          summary: entry.summary,
          ...(typeof entry.tokensBefore === "number" ? { tokensBefore: entry.tokensBefore } : {}),
        },
      });
      continue;
    }
    if (type === "custom_message" && entry.display !== false) {
      const text = messageText(entry.content);
      if (!text.trim()) continue;
      beginTurn();
      const id = typeof entry.id === "string" ? entry.id : undefined;
      events.push({ type: "message_start", message: { role: "assistant", id } });
      events.push({ type: "message_end", message: { role: "assistant", content: text, id } });
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const role = message.role;
    if (role === "bashExecution") {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      beginTurn();
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      const failed =
        message.cancelled === true ||
        (typeof message.exitCode === "number" && message.exitCode !== 0);
      events.push({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "bash",
        args: { command },
      });
      events.push({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "bash",
        result: { content: [{ type: "text", text: output }] },
        isError: failed,
      });
      continue;
    }
    if (isUserRole(role) || isAssistantRole(role)) {
      if (timestamp > 0) lastMessageAt = Math.max(lastMessageAt, timestamp);
    }
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
  const createdAt = headerAt || firstAt || now;
  return {
    summary: {
      title,
      createdAt,
      // 打开会话时写入的 label/custom 不能把原会话抬成「刚刚」，否则新分叉会排到它下面。
      lastActivityAt: Math.max(headerAt, lastMessageAt) || createdAt,
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
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
