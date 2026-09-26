import { ensureAppDataDir } from "@zcode/shared/node";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;

export interface PiAppUsageQuery {
  totals: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    modelRequestCount: number;
    modelErrorCount: number;
    avgTimeToFirstTokenMs: number | null;
  };
  turnTotals: {
    totalSessions: number;
    totalTurns: number;
    avgTurnDurationMs: number | null;
    longestSessionMs: number;
  };
  toolTotals: { toolCallCount: number; toolErrorCount: number };
  models: Array<{
    modelId: string | null;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
  }>;
  tools: Array<{
    toolName: string;
    callCount: number;
    errorCount: number;
    avgDurationMs: number | null;
  }>;
  days: Array<{ dayIndex: number; totalTokens: number; turnCount: number; toolCallCount: number }>;
  dayModels: Array<{ dayIndex: number; modelId: string | null; totalTokens: number }>;
}

interface UsageWindow {
  since: number;
  until: number;
  tzOffsetMs: number;
}

interface ModelBucket {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

interface ToolBucket {
  toolName: string;
  callCount: number;
  errorCount: number;
}

interface DayBucket {
  dayIndex: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

interface ParsedEntry {
  id?: string;
  parentId?: string;
  type?: string;
  timestamp: number;
  message: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 有 parentId 的文件只留当前叶子。没有树的旧文件整份计入。 */
function activeIdSet(entries: ParsedEntry[]): Set<string> | null {
  const byId = new Map<string, ParsedEntry>();
  for (const entry of entries) {
    if (entry.id && entry.type !== "session") byId.set(entry.id, entry);
  }
  let leaf: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.id && entry.type !== "session") {
      leaf = entry.id;
      break;
    }
  }
  if (!leaf || !entries.some((entry) => entry.parentId)) return null;
  const keep = new Set<string>();
  let current = byId.get(leaf);
  while (current?.id && !keep.has(current.id)) {
    keep.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return keep;
}

function parseEntries(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of content.split(/\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = asRecord(JSON.parse(trimmed) as unknown);
      if (!record) continue;
      entries.push({
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.parentId === "string" ? { parentId: record.parentId } : {}),
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        timestamp: timeMs(record.timestamp),
        message: asRecord(record.message),
      });
    } catch {
      // 坏行跳过，不让一份会话挡住整页统计。
    }
  }
  return entries;
}

function inWindow(timestamp: number, window: UsageWindow): boolean {
  return timestamp > window.since && timestamp <= window.until;
}

/** 只读汇总。seen 跨文件共用，分叉抄来的同一条消息只计一次。 */
export class PiUsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly models = new Map<string, ModelBucket>();
  private readonly tools = new Map<string, ToolBucket>();
  private readonly days = new Map<number, DayBucket>();
  private readonly dayModels = new Map<string, number>();
  private totalTokens = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reasoningTokens = 0;
  private cacheCreationTokens = 0;
  private cacheReadTokens = 0;
  private modelRequestCount = 0;
  private modelErrorCount = 0;
  private totalSessions = 0;
  private totalTurns = 0;
  private longestSessionMs = 0;
  private toolCallCount = 0;
  private toolErrorCount = 0;

  addFile(content: string, window: UsageWindow): void {
    const entries = parseEntries(content);
    const active = activeIdSet(entries);
    let contributed = false;
    let first = 0;
    let last = 0;
    for (const entry of entries) {
      if (entry.type === "session" || (active && entry.id && !active.has(entry.id))) continue;
      if (entry.id && this.seen.has(entry.id)) continue;
      const counted = this.addEntry(entry, window);
      if (!counted || !entry.timestamp) continue;
      if (entry.id) this.seen.add(entry.id);
      contributed = true;
      first = first === 0 ? entry.timestamp : Math.min(first, entry.timestamp);
      last = Math.max(last, entry.timestamp);
    }
    if (!contributed) return;
    this.totalSessions += 1;
    if (last > first) this.longestSessionMs = Math.max(this.longestSessionMs, last - first);
  }

  toQuery(): PiAppUsageQuery {
    const models = [...this.models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const tools = [...this.tools.values()]
      .sort((a, b) => b.callCount - a.callCount)
      .map((tool) => ({ ...tool, avgDurationMs: null }));
    const days = [...this.days.values()].sort((a, b) => a.dayIndex - b.dayIndex);
    const dayModels = [...this.dayModels.entries()].map(([key, total]) => {
      const split = key.indexOf("\u0000");
      const modelId = key.slice(split + 1);
      return {
        dayIndex: Number(key.slice(0, split)),
        modelId: modelId || null,
        totalTokens: total,
      };
    });
    return {
      totals: {
        totalTokens: this.totalTokens,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        reasoningTokens: this.reasoningTokens,
        cacheCreationTokens: this.cacheCreationTokens,
        cacheReadTokens: this.cacheReadTokens,
        modelRequestCount: this.modelRequestCount,
        modelErrorCount: this.modelErrorCount,
        avgTimeToFirstTokenMs: null,
      },
      turnTotals: {
        totalSessions: this.totalSessions,
        totalTurns: this.totalTurns,
        avgTurnDurationMs: null,
        longestSessionMs: this.longestSessionMs,
      },
      toolTotals: { toolCallCount: this.toolCallCount, toolErrorCount: this.toolErrorCount },
      models,
      tools,
      days,
      dayModels,
    };
  }

  private addEntry(entry: ParsedEntry, window: UsageWindow): boolean {
    if (!inWindow(entry.timestamp, window)) return false;
    const message = entry.message;
    if (!message) return false;
    const role = message.role;
    if (role === "user") {
      this.totalTurns += 1;
      this.day(entry.timestamp, window).turnCount += 1;
      return true;
    }
    if (role === "assistant") return this.addAssistant(entry, message, window);
    if (role === "toolResult" || role === "tool") return this.addToolResult(message);
    if (role === "bashExecution") return this.addBash(entry, message, window);
    return false;
  }

  private addAssistant(
    entry: ParsedEntry,
    message: Record<string, unknown>,
    window: UsageWindow,
  ): boolean {
    const usage = asRecord(message.usage);
    const input = num(usage?.input);
    const output = num(usage?.output);
    const cacheRead = num(usage?.cacheRead);
    const cacheWrite = num(usage?.cacheWrite);
    const prompt = input + cacheRead + cacheWrite;
    const total = Math.max(num(usage?.totalTokens), prompt + output);
    this.modelRequestCount += 1;
    if (message.stopReason === "error" || typeof message.errorMessage === "string") {
      this.modelErrorCount += 1;
    }
    this.totalTokens += total;
    this.inputTokens += prompt;
    this.outputTokens += output;
    this.reasoningTokens += num(usage?.reasoning);
    this.cacheCreationTokens += cacheWrite;
    this.cacheReadTokens += cacheRead;
    const modelId = typeof message.model === "string" && message.model ? message.model : null;
    const model = this.models.get(modelId ?? "") ?? {
      modelId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    };
    model.totalTokens += total;
    model.inputTokens += prompt;
    model.outputTokens += output;
    model.requestCount += 1;
    this.models.set(modelId ?? "", model);
    const day = this.day(entry.timestamp, window);
    day.totalTokens += total;
    const dayKey = `${day.dayIndex}\u0000${modelId ?? ""}`;
    this.dayModels.set(dayKey, (this.dayModels.get(dayKey) ?? 0) + total);
    this.addToolCalls(message.content, day);
    return true;
  }

  private addToolCalls(content: unknown, day: DayBucket): void {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const record = asRecord(part);
      if (!record || (record.type !== "toolCall" && record.type !== "tool_call")) continue;
      const name = typeof record.name === "string" && record.name ? record.name : "unknown";
      const id = typeof record.id === "string" ? record.id : "";
      if (id && this.seen.has(`tool:${id}`)) continue;
      if (id) this.seen.add(`tool:${id}`);
      this.noteTool(name, false);
      day.toolCallCount += 1;
    }
  }

  private addToolResult(message: Record<string, unknown>): boolean {
    if (message.isError !== true) return false;
    const name = typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown";
    const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (id && this.seen.has(`tool-error:${id}`)) return false;
    if (id) this.seen.add(`tool-error:${id}`);
    const tool = this.toolBucket(name);
    if (!id || !this.seen.has(`tool:${id}`)) {
      if (id) this.seen.add(`tool:${id}`);
      tool.callCount += 1;
      this.toolCallCount += 1;
    }
    tool.errorCount += 1;
    this.toolErrorCount += 1;
    return true;
  }

  private addBash(
    entry: ParsedEntry,
    message: Record<string, unknown>,
    window: UsageWindow,
  ): boolean {
    const failed =
      message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
    this.noteTool("bash", failed);
    this.day(entry.timestamp, window).toolCallCount += 1;
    return true;
  }

  private noteTool(name: string, failed: boolean): void {
    const tool = this.toolBucket(name);
    tool.callCount += 1;
    this.toolCallCount += 1;
    if (!failed) return;
    tool.errorCount += 1;
    this.toolErrorCount += 1;
  }

  private toolBucket(name: string): ToolBucket {
    const tool = this.tools.get(name) ?? { toolName: name, callCount: 0, errorCount: 0 };
    this.tools.set(name, tool);
    return tool;
  }

  private day(timestamp: number, window: UsageWindow): DayBucket {
    const dayIndex = Math.floor((timestamp + window.tzOffsetMs) / DAY_MS);
    const day = this.days.get(dayIndex) ?? {
      dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    this.days.set(dayIndex, day);
    return day;
  }
}

export function defaultPiUsageRoots(storageRoot = join(ensureAppDataDir(homedir()))): string[] {
  return [join(homedir(), ".pi", "agent", "sessions"), join(storageRoot, "pi-host-sessions")];
}

async function walkJsonl(
  dir: string,
  depth: number,
  visit: (file: string) => Promise<void>,
): Promise<void> {
  if (depth > 6) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, depth + 1, visit);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) await visit(full);
  }
}

export async function queryPiSessionUsage(
  window: UsageWindow,
  roots = defaultPiUsageRoots(),
): Promise<PiAppUsageQuery> {
  const usage = new PiUsageAccumulator();
  for (const root of roots) {
    await walkJsonl(root, 0, async (file) => {
      // 时间窗以外、很久没改过的文件没有新用量，不必整份解析。
      if (window.since > 0) {
        const info = await stat(file).catch(() => null);
        if (!info || info.mtimeMs <= window.since) return;
      }
      const content = await readFile(file, "utf8").catch(() => "");
      if (content) usage.addFile(content, window);
    });
  }
  return usage.toQuery();
}
