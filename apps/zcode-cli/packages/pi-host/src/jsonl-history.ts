import type { PiHostEvent, PiMessageUsage } from "./types.js";

export type PiJsonlSummary = {
  title: string;
  /** session_info.name 写过的名字。false 时 title 只是首条用户原文的回退。 */
  named: boolean;
  createdAt: number;
  lastActivityAt: number;
  cwd?: string;
  lastAssistantPreview?: string;
  sessionId?: string;
  /** 分叉来源。Pi 写入的是父会话 jsonl 的绝对路径，旧数据也可能直接是会话 id。 */
  parentSession?: string;
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

/** 单独一条斜杠命令是控制动作，不是用户要办的事。 */
export function isControlCommandTitle(text: string): boolean {
  return /^\/\S+$/u.test(text.trim());
}

const PI_IMAGE_MODEL_HINT =
  /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]$|^\[Image converted from \S+ to \S+\.\]$/u;

/** 附件正文和 Pi 的图片缩放说明只给模型。气泡、标题、回退原文留用户自己写的字。 */
export function visibleUserText(text: string): string {
  const withoutFiles = text.replace(/\n*<zcode-file>[\s\S]*?<\/zcode-file>/gu, "");
  const kept = withoutFiles
    .split("\n")
    .filter((line) => !PI_IMAGE_MODEL_HINT.test(line.trim()))
    .join("\n")
    .trimEnd();
  return kept.trim().length === 0 ? "" : kept;
}

/**
 * 重放时把 jsonl 里 assistant 消息已经写下的用量和时长搬回去。缺了它们，
 * 重开会话就看不清上一轮的用量。只搬 Pi 已记录的字段，不重算 token。
 */
function replayedUsageFields(
  message: Record<string, unknown>,
  entryTimestamp: number,
): {
  usage?: PiMessageUsage;
  timestamp?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
} {
  const numberField = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const usage = asRecord(message.usage);
  const startedAt = numberField(message.timestamp);
  const recordedDuration = numberField(message.durationMs);
  // legacy 消息没有 durationMs：用落盘时刻与请求开始时刻的差回退。这会略微高估
  // （含持久化开销），只用于历史重放，且两个时刻都在时才算。
  const durationMs =
    recordedDuration ??
    (startedAt !== undefined && entryTimestamp > 0
      ? Math.max(0, entryTimestamp - startedAt)
      : undefined);
  const input = numberField(usage?.input);
  const output = numberField(usage?.output);
  const cacheRead = numberField(usage?.cacheRead);
  const cacheWrite = numberField(usage?.cacheWrite);
  const totalTokens = numberField(usage?.totalTokens);
  return {
    ...(input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
      ? {}
      : {
          usage: {
            ...(input === undefined ? {} : { input }),
            ...(output === undefined ? {} : { output }),
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
          },
        }),
    ...(startedAt === undefined ? {} : { timestamp: startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
  };
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

export function readPiJsonl(
  content: string,
  options?: { settle?: boolean },
): {
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
  let parentSession: string | undefined;
  let firstUser = "";
  let lastAssistant = "";
  const events: PiHostEvent[] = [];
  let inTurn = false;
  let turnLastAt = 0;

  const noteAt = (at: number) => {
    if (at > 0) turnLastAt = Math.max(turnLastAt, at);
  };
  const beginTurn = (at: number) => {
    if (inTurn) return;
    turnLastAt = at > 0 ? at : 0;
    events.push(at > 0 ? { type: "agent_start", at } : { type: "agent_start" });
    inTurn = true;
  };
  const endTurn = () => {
    if (!inTurn) return;
    const at = turnLastAt;
    events.push(at > 0 ? { type: "agent_settled", at } : { type: "agent_settled" });
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
      // 分叉关系只写在 header。丢了它，分支图谱和父会话跳转就都没有边。
      if (typeof entry.parentSession === "string" && entry.parentSession) {
        parentSession = entry.parentSession;
      }
      continue;
    }
    if (type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      if (!isControlCommandTitle(entry.name)) namedTitle = clip(entry.name, 60);
      continue;
    }
    if (type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
      events.push({ type: "branch_summary", summary: entry.summary });
      continue;
    }
    if (type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
      noteAt(timestamp);
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
    if (type === "custom" && entry.customType === "zcode-extension-output") {
      const data = asRecord(entry.data);
      const text = typeof data?.text === "string" ? data.text : "";
      const command = typeof data?.command === "string" ? data.command : "";
      if (!text.trim()) continue;
      events.push({
        type: "extension_output",
        command,
        text,
        ...(timestamp > 0 ? { at: timestamp } : {}),
      });
      continue;
    }
    if (type === "custom_message" && entry.display !== false) {
      const text = messageText(entry.content);
      if (!text.trim()) continue;
      beginTurn(timestamp);
      noteAt(timestamp);
      const id = typeof entry.id === "string" ? entry.id : undefined;
      events.push({ type: "message_start", ...(timestamp > 0 ? { at: timestamp } : {}), message: { role: "assistant", id } });
      events.push({ type: "message_end", ...(timestamp > 0 ? { at: timestamp } : {}), message: { role: "assistant", content: text, id } });
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const role = message.role;
    if (role === "bashExecution") {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id) continue;
      beginTurn(timestamp);
      noteAt(timestamp);
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      const failed =
        message.cancelled === true ||
        (typeof message.exitCode === "number" && message.exitCode !== 0);
      events.push({
        type: "tool_execution_start",
        ...(timestamp > 0 ? { at: timestamp } : {}),
        toolCallId: id,
        toolName: "bash",
        args: { command },
      });
      events.push({
        type: "tool_execution_end",
        ...(timestamp > 0 ? { at: timestamp } : {}),
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
      const visible = visibleUserText(text);
      const titleText = visible.trim() ? visible : text;
      if (!firstUser && titleText.trim() && !isControlCommandTitle(titleText)) firstUser = titleText;
      endTurn();
      beginTurn(timestamp);
      events.push({
        type: "message_start",
        message: { role: "user", content: text, id: typeof entry.id === "string" ? entry.id : undefined },
      });
      continue;
    }
    if (isAssistantRole(role)) {
      beginTurn(timestamp);
      noteAt(timestamp);
      const id = typeof entry.id === "string" ? entry.id : undefined;
      events.push({
        type: "message_start",
        ...(timestamp > 0 ? { at: timestamp } : {}),
        message: { role: "assistant", id },
      });
      for (const call of toolCallsOf(message.content)) {
        events.push({
          type: "tool_execution_start",
          ...(timestamp > 0 ? { at: timestamp } : {}),
          toolCallId: call.id,
          toolName: call.name,
          args: call.args,
        });
      }
      const text = messageText(message.content);
      if (text.trim()) lastAssistant = text;
      events.push({
        type: "message_end",
        ...(timestamp > 0 ? { at: timestamp } : {}),
        message: {
          role: "assistant",
          content: message.content,
          id,
          ...replayedUsageFields(message, timestamp),
        },
      });
      continue;
    }
    if (isToolResultRole(role)) {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      if (!toolCallId) continue;
      noteAt(timestamp);
      events.push({
        type: "tool_execution_end",
        ...(timestamp > 0 ? { at: timestamp } : {}),
        toolCallId,
        toolName,
        result: { content: [{ type: "text", text: messageText(message.content) }] },
        isError: message.isError === true,
      });
    }
  }
  // 还在跑的子会话文件没有轮次结束标记。提前 settle 会把工时收成重放墙钟（约 1 秒）并折叠工具。
  if (options?.settle !== false) endTurn();

  // 只有扩展命令输出、还没有用户消息时也要重放这些输出。没有标题不等于没有事件。
  if (!firstUser && !namedTitle) return { summary: null, events };
  const title = namedTitle ?? clip(firstUser, 60);
  const createdAt = headerAt || firstAt || now;
  return {
    summary: {
      title,
      named: namedTitle !== undefined,
      createdAt,
      // 打开会话时写入的 label/custom 不能把原会话抬成「刚刚」，否则新分叉会排到它下面。
      lastActivityAt: Math.max(headerAt, lastMessageAt) || createdAt,
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(parentSession ? { parentSession } : {}),
      ...(lastAssistant ? { lastAssistantPreview: clip(lastAssistant, 120) } : {}),
    },
    events,
  };
}

export function summarizePiJsonl(content: string): PiJsonlSummary | null {
  return readPiJsonl(content).summary;
}

/**
 * jsonl 重放后是否用摘要标题覆盖当前标题。
 * 没有 session_info 名字时，title 只是首条原文。不能盖掉已经总结好的标题，
 * 否则侧栏会先闪回原文，等名字落盘后再闪回总结。
 */
export function shouldApplyStoredSessionTitle(input: {
  currentTitle: string;
  currentTitleSource: "default" | "generated" | "custom" | undefined;
  storedTitle: string;
  storedTitleNamed: boolean;
}): boolean {
  if (input.currentTitleSource === "custom") return false;
  const stored = input.storedTitle.trim();
  if (!stored) return false;
  const current = input.currentTitle.trim();
  if (current === stored) return false;
  if (!input.storedTitleNamed && current && input.currentTitleSource !== "default") return false;
  return true;
}

export function replayPiJsonl(content: string): PiHostEvent[] {
  return readPiJsonl(content).events;
}
