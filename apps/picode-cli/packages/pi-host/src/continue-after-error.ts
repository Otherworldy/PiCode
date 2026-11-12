import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export interface ContinueMessage {
  role?: string;
  stopReason?: string;
}

/** 失败的助手回复留在 jsonl 里，但不能留在接着跑的上下文里。 */
export function prepareContinueMessages<T extends ContinueMessage>(
  messages: readonly T[],
): { ok: true; messages: T[] } | { ok: false } {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (message?.role !== "assistant" || message.stopReason !== "error") break;
    end -= 1;
  }
  const next = end === messages.length ? messages : messages.slice(0, end);
  const tail = next.at(-1);
  if (!tail || tail.role === "assistant" || tail.role === "system") return { ok: false };
  return { ok: true, messages: next.slice() };
}

export interface ContinueTranscript {
  sessionManager: SessionManager;
  replaceMessages(messages: ReturnType<SessionManager["buildSessionProjection"]>["messages"]): void;
}

/**
 * 失败助手必须从 Pi session projection 里拿掉，不能只切内存数组。
 * 下一次请求走 prepareRequest，上下文以 projection 为准。失败消息还在末尾时，
 * 供应商把这条空助手当成已经说完，请求成功后立刻 stop，界面没有新输出。
 * 依据：Pi 自动重试用 appendContextEdit(id, null) 做同样的省略。
 */
export function omitFailedAssistantForContinue(
  session: ContinueTranscript,
): { ok: true } | { ok: false } {
  let previousLength = Number.POSITIVE_INFINITY;
  for (;;) {
    const projected = session.sessionManager.buildSessionProjection().messages;
    const prepared = prepareContinueMessages(projected);
    if (!prepared.ok) return { ok: false };
    if (prepared.messages.length === projected.length) {
      session.replaceMessages(projected);
      return { ok: true };
    }
    if (projected.length >= previousLength) return { ok: false };
    previousLength = projected.length;
    const failed = projected.at(-1);
    const targetId = failed
      ? failedAssistantEntryId(session.sessionManager.getBranch(), failed)
      : undefined;
    if (!targetId) return { ok: false };
    session.sessionManager.appendContextEdit(targetId, null);
  }
}

function failedAssistantEntryId(
  branch: readonly SessionEntry[],
  message: ContinueMessage,
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message === message) return entry.id;
  }
  return undefined;
}

interface ContinuablePiSession {
  agent: {
    state: { messages: ContinueMessage[] };
    continue(): Promise<void>;
  };
  _agentRunAbortRequested: boolean;
  _isAgentRunActive: boolean;
  _runSystemPromptOptions: unknown;
  _finishCancelledRetry(): void;
  _flushPendingBashMessages(): void;
  _flushPendingCustomMessages(): void;
  _emitAgentSettled(): Promise<void>;
}

/** 走和 prompt 一样的忙标记，否则 Stop 会以为会话是空闲的。 */
export async function runContinueAfterModelError(session: ContinuablePiSession): Promise<void> {
  session._agentRunAbortRequested = false;
  session._isAgentRunActive = true;
  try {
    await session.agent.continue();
  } finally {
    if (session._agentRunAbortRequested) session._finishCancelledRetry();
    session._runSystemPromptOptions = undefined;
    session._flushPendingBashMessages();
    session._flushPendingCustomMessages();
    await session._emitAgentSettled();
  }
}
