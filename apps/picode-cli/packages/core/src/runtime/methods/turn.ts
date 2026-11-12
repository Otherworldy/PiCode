import type { TurnState } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnStartReservation, ExecuteTurnOptions, TurnResult } from "../types.js";

function disabled(): never {
  throw new Error("executeTurn is disabled; use Pi Host session.prompt");
}

export async function executeTurn(
  this: AgentRuntimeInternal,
  _input: string,
  _attachments?: TurnState["attachments"],
  _options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  disabled();
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  _input: string,
  _attachments?: TurnState["attachments"],
  _options?: ExecuteTurnOptions,
  _startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  disabled();
}
