import {
  collectEntriesForBranchSummary,
  generateBranchSummary,
  type AgentSession,
  type GenerateBranchSummaryOptions,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolveSessionEntry } from "./session-tree.js";

export type AbandonedBranch = {
  entries: readonly SessionEntry[];
};

/** 裁切之前记下将被丢掉的路径。叶子已经挪走之后再收集，这段就空了。 */
export function captureAbandonedBranch(
  session: AgentSession,
  request: { entryId: string; text?: string; role?: "user" | "assistant" | "tool" },
): AbandonedBranch | undefined {
  const manager = session.sessionManager;
  const oldLeafId = manager.getLeafId();
  if (!oldLeafId) return undefined;
  const resolved =
    resolveSessionEntry(manager, request.entryId, {
      ...(request.text ? { text: request.text } : {}),
      ...(request.role ? { role: request.role } : {}),
    }) || (manager.getEntry(request.entryId) ? request.entryId : "");
  if (!resolved || resolved === oldLeafId || !manager.getEntry(resolved)) return undefined;
  const { entries } = collectEntriesForBranchSummary(manager, oldLeafId, resolved);
  return entries.length > 0 ? { entries } : undefined;
}

/**
 * 新叶子已经就位之后，把丢掉的路径总结成它的下一条。
 * 取消走 Pi 的 abortBranchSummary，所以要挂上同一个 AbortController。
 */
export async function summarizeAbandonedBranch(
  session: AgentSession,
  captured: AbandonedBranch,
  options?: { customInstructions?: string; label?: string },
): Promise<{ cancelled: boolean; summary?: string }> {
  if (!session.model) throw new Error("No model available for summarization");
  const controller = new AbortController();
  const internals = session as unknown as {
    _branchSummaryAbortController?: AbortController;
    _getSummarizationRequestAuth(
      model: NonNullable<AgentSession["model"]>,
      signal: AbortSignal,
    ): Promise<
      Partial<GenerateBranchSummaryOptions> & { model: GenerateBranchSummaryOptions["model"] }
    >;
    _summarizationRetryCallbacks(input: {
      source: string;
    }): GenerateBranchSummaryOptions["callbacks"];
  };
  internals._branchSummaryAbortController = controller;
  try {
    const auth = await internals._getSummarizationRequestAuth(session.model, controller.signal);
    const result = await generateBranchSummary([...captured.entries], {
      ...auth,
      signal: controller.signal,
      ...(options?.customInstructions ? { customInstructions: options.customInstructions } : {}),
      reserveTokens: session.settingsManager.getBranchSummarySettings().reserveTokens,
      streamFn: session.agent.streamFunction,
      retry: session.settingsManager.getRetrySettings(),
      callbacks: internals._summarizationRetryCallbacks({ source: "branchSummary" }),
    });
    if (result.aborted || controller.signal.aborted) return { cancelled: true };
    if (result.error) throw new Error(result.error);
    const summary = result.summary?.trim();
    if (!summary) return { cancelled: false };
    const manager = session.sessionManager;
    const summaryId = manager.branchWithSummary(
      manager.getLeafId(),
      summary,
      { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
      false,
      result.usage,
    );
    if (options?.label) manager.appendLabelChange(summaryId, options.label);
    session.agent.state.messages = manager.buildSessionProjection().messages;
    return { cancelled: false, summary };
  } finally {
    if (internals._branchSummaryAbortController === controller) {
      internals._branchSummaryAbortController = undefined;
    }
  }
}
