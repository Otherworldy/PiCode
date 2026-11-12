import type { SessionGoal, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TargetCompletionVerificationResult } from "./target-completion-verification.js";

export async function runTargetCompletionVerificationWithTelemetry(
  _runtime: AgentRuntimeInternal,
  _input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
  execute: () => Promise<TargetCompletionVerificationResult>,
): Promise<TargetCompletionVerificationResult> {
  return execute();
}
