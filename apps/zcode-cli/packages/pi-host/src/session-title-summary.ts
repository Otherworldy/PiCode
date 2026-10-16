import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isControlCommandTitle } from "./jsonl-history.js";

export const TITLE_SUMMARY_FILE = "zcode-title-summary.json";
export const TITLE_SUMMARY_MAX_CHARS = 60;

export const TITLE_SUMMARY_SYSTEM_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  "3. Keep it under 25 characters (or 4-7 words).\n" +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").\n" +
  "6. Never answer the user's question or fulfill their request.";

export type TitleSummarySettings = {
  enabled: boolean;
  provider?: string;
  model?: string;
};

export type TitleSummaryRow = {
  kind: string;
  text?: string;
  origin?: string;
};

export type TitleSummarySeed = {
  userPrompt: string;
  assistantReply?: string;
  realUserCount: number;
};

const attempted = new Set<string>();
const inflight = new Set<string>();

/**
 * 会话的模型请求先走。总结在它发出之后并行开始，不等整轮结束。
 * 用户消息一落地就排上总结会抢在会话请求前面，页面会停在标题上。
 */
export function createSessionFirstGate(): {
  readonly closed: boolean;
  ready: () => Promise<void>;
  sessionGoesFirst: () => void;
  close: () => void;
} {
  let closed = false;
  let open = false;
  const waiters: Array<() => void> = [];
  const wake = () => {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  };
  return {
    get closed() {
      return closed;
    },
    ready() {
      if (closed || open) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    sessionGoesFirst() {
      if (open) return;
      open = true;
      wake();
    },
    close() {
      closed = true;
      wake();
    },
  };
}

export function titleSummaryUserContent(userPrompt: string, assistantReply?: string): string {
  const prompt = userPrompt.trim().slice(0, 1000);
  const reply = assistantReply?.trim().slice(0, 500) ?? "";
  return reply
    ? `User Prompt:\n${prompt}\n\nAssistant Response Summary:\n${reply}`
    : `User Prompt:\n${prompt}`;
}

/** 手动总结用：保留开头和最近一句，避免整段历史把标题请求撑爆。 */
export function titleSummaryRequest(userTexts: readonly string[], assistantReply?: string): string | null {
  const users = userTexts
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && !isControlCommandTitle(text));
  if (users.length === 0) return null;
  const picked =
    users.length <= 3 ? users : [users[0]!, users[1]!, users[users.length - 1]!];
  const body = picked.map((text, index) => `${index + 1}. ${text.slice(0, 400)}`).join("\n");
  const reply = assistantReply?.trim().slice(0, 500) ?? "";
  return reply ? `User messages:\n${body}\n\nLatest assistant reply:\n${reply}` : `User messages:\n${body}`;
}

export function titleExcerptFromRows(rows: readonly TitleSummaryRow[]): {
  userTexts: string[];
  assistantText?: string;
} {
  const userTexts: string[] = [];
  let assistantText = "";
  for (const row of rows) {
    const text = row.text?.trim() ?? "";
    if (!text) continue;
    if (row.kind === "userInput" && row.origin === "realUser" && !isControlCommandTitle(text)) {
      userTexts.push(text);
    } else if (row.kind === "assistantText") {
      assistantText = text;
    }
  }
  return { userTexts, ...(assistantText ? { assistantText } : {}) };
}

export function titleExcerptFromJsonl(content: string): {
  userTexts: string[];
  assistantText?: string;
  provider?: string;
  model?: string;
} {
  const userTexts: string[] = [];
  let assistantText = "";
  let provider = "";
  let model = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") provider = entry.provider;
      if (typeof entry.modelId === "string") model = entry.modelId;
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    const text = jsonlMessageText(message.content);
    if (message.role === "assistant") {
      if (typeof message.provider === "string" && message.provider) provider = message.provider;
      if (typeof message.model === "string" && message.model) model = message.model;
      if (text.trim()) assistantText = text;
    } else if (message.role === "user" && text.trim() && !isControlCommandTitle(text)) {
      userTexts.push(text);
    }
  }
  return {
    userTexts,
    ...(assistantText.trim() ? { assistantText } : {}),
    ...(provider.trim() && model.trim() ? { provider: provider.trim(), model: model.trim() } : {}),
  };
}

function jsonlMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

export function cleanSummarizedTitle(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { title?: unknown };
      if (typeof parsed.title === "string" && parsed.title.trim()) text = parsed.title.trim();
    } catch {
      // 不是 JSON 就按原文清洗。
    }
  }
  text = text.replace(/^[`"'\u201c\u201d\u300c\u300d*]+|[`"'\u201c\u201d\u300c\u300d*]+$/g, "").trim();
  text = text.replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "").trim();
  text = text.replace(/\s+/g, " ");
  text = text.replace(/[.。!！?？]+$/g, "").trim();
  if (!/[A-Za-z0-9\u3400-\u9fff]/u.test(text)) return "";
  return text.slice(0, TITLE_SUMMARY_MAX_CHARS);
}

export function titleSummarySeed(rows: readonly TitleSummaryRow[]): TitleSummarySeed | null {
  let userPrompt = "";
  let realUserCount = 0;
  let assistantReply = "";
  for (const row of rows) {
    const text = row.text?.trim() ?? "";
    if (!text) continue;
    if (row.kind === "userInput" && row.origin === "realUser" && !isControlCommandTitle(text)) {
      realUserCount += 1;
      if (!userPrompt) userPrompt = text;
    } else if (row.kind === "assistantText" && !assistantReply) {
      assistantReply = text;
    }
  }
  if (!userPrompt) return null;
  return {
    userPrompt,
    realUserCount,
    ...(assistantReply ? { assistantReply } : {}),
  };
}

export function applyTitleSummaryPatch(
  current: TitleSummarySettings,
  patch: { enabled?: boolean; provider?: string; model?: string },
): TitleSummarySettings {
  const enabled = patch.enabled ?? current.enabled;
  const provider = (patch.provider !== undefined ? patch.provider : (current.provider ?? "")).trim();
  const model = (patch.model !== undefined ? patch.model : (current.model ?? "")).trim();
  return {
    enabled,
    ...(provider && model ? { provider, model } : {}),
  };
}

export async function readTitleSummarySettings(agentDir: string): Promise<TitleSummarySettings> {
  try {
    const raw = JSON.parse(await readFile(join(agentDir, TITLE_SUMMARY_FILE), "utf8")) as {
      enabled?: unknown;
      provider?: unknown;
      model?: unknown;
    };
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    return {
      enabled: raw.enabled !== false,
      ...(provider && model ? { provider, model } : {}),
    };
  } catch {
    return { enabled: true };
  }
}

export async function writeTitleSummarySettings(
  agentDir: string,
  settings: TitleSummarySettings,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const body = {
    enabled: settings.enabled,
    ...(settings.provider && settings.model
      ? { provider: settings.provider, model: settings.model }
      : {}),
  };
  await writeFile(join(agentDir, TITLE_SUMMARY_FILE), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** 第一条用户消息就排上总结。模型请求等会话自己的请求发出后并行开始，不等整轮结束。重放的 agent_settled 不算。 */
export function shouldAutoSummarizeTitle(event: {
  type: string;
  willRetry?: boolean;
  message?: { role?: string };
}): boolean {
  if (event.type === "message_start" && event.message?.role === "user") return true;
  return event.type === "agent_end" && event.willRetry !== true;
}

export function scheduleSessionTitleSummary(input: {
  sessionId: string;
  parentSessionId?: string;
  titleSource?: string;
  sessionName?: string;
  rows: readonly TitleSummaryRow[];
  fallbackProvider?: string;
  fallbackModel?: string;
  readSettings: () => Promise<TitleSummarySettings>;
  complete: (request: {
    providerId: string;
    modelId: string;
    system: string;
    prompt: string;
  }) => Promise<string | null>;
  stillEligible: () => boolean;
  commit: (title: string) => void;
  onError?: (error: unknown) => void;
}): void {
  const sessionId = input.sessionId.trim();
  if (!sessionId || attempted.has(sessionId) || inflight.has(sessionId)) return;
  if (input.parentSessionId) return;
  if (input.titleSource === "custom" || input.sessionName?.trim()) return;
  const seed = titleSummarySeed(input.rows);
  // 只总结第一轮。之后再开口关，也不回头改已经聊过的会话。
  if (!seed || seed.realUserCount !== 1) return;
  inflight.add(sessionId);
  void run(sessionId, seed, input)
    .catch((error: unknown) => input.onError?.(error))
    .finally(() => {
      inflight.delete(sessionId);
    });
}

async function run(
  sessionId: string,
  seed: TitleSummarySeed,
  input: {
    fallbackProvider?: string;
    fallbackModel?: string;
    readSettings: () => Promise<TitleSummarySettings>;
    complete: (request: {
      providerId: string;
      modelId: string;
      system: string;
      prompt: string;
    }) => Promise<string | null>;
    stillEligible: () => boolean;
    commit: (title: string) => void;
  },
): Promise<void> {
  const settings = await input.readSettings();
  if (!settings.enabled || !input.stillEligible()) return;
  const prompt = titleSummaryUserContent(seed.userPrompt, seed.assistantReply);
  const preferred =
    settings.provider && settings.model
      ? { providerId: settings.provider, modelId: settings.model }
      : undefined;
  const fallback =
    input.fallbackProvider?.trim() && input.fallbackModel?.trim()
      ? { providerId: input.fallbackProvider.trim(), modelId: input.fallbackModel.trim() }
      : undefined;
  if (!preferred && !fallback) return;
  const requestFor = (model: { providerId: string; modelId: string }) => ({
    ...model,
    system: TITLE_SUMMARY_SYSTEM_PROMPT,
    prompt,
  });
  const sameModel =
    preferred !== undefined &&
    fallback !== undefined &&
    fallback.providerId === preferred.providerId &&
    fallback.modelId === preferred.modelId;
  let raw: string | null = null;
  if (preferred) {
    try {
      raw = await input.complete(requestFor(preferred));
    } catch (error) {
      // 指定总结模型失败时还有对话模型可试，不要让这一次失败结束掉标题生成。
      if (!fallback || sameModel) throw error;
    }
  }
  if (!raw && fallback && !sameModel) {
    raw = await input.complete(requestFor(fallback));
  }
  const title = raw ? cleanSummarizedTitle(raw) : "";
  if (!title) return;
  const latest = await input.readSettings();
  if (!latest.enabled || !input.stillEligible()) return;
  input.commit(title);
  attempted.add(sessionId);
}
