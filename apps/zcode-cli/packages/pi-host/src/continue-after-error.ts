export interface ContinueMessage {
  role?: string;
  stopReason?: string;
}

/** 失败的助手回复留在 jsonl 里，但不能留在接着跑的上下文里。 */
export function prepareContinueMessages<T extends ContinueMessage>(
  messages: readonly T[],
): { ok: true; messages: T[] } | { ok: false } {
  let next = messages;
  const last = next.at(-1);
  if (last?.role === "assistant" && last.stopReason === "error") {
    next = next.slice(0, -1);
  }
  const tail = next.at(-1);
  if (!tail || tail.role === "assistant" || tail.role === "system") return { ok: false };
  return { ok: true, messages: next.slice() };
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
