import { applySessionFileRewind } from "../../../picode-protocol/session-files.js";
import { sessionIdOf } from "../../../picode-protocol/session-owner.js";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@picode/shared/picode-protocol-v4";
import type { MessageId, TurnId } from "@picode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

async function applyFileRewind(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["applyFileRewind"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    sessionIdOf(record),
    payload.target,
    "applyFileRewind",
  );
  if (!resolution?.ok) {
    throw new V4RowTranslationError("applyFileRewind", payload.target.rowId);
  }
  const targetMessageIds = (resolution.messageIds ?? []) as MessageId[];
  const targetTurnId = resolution.row.turnId as TurnId;
  const result = await applySessionFileRewind(record, {
    targetMessageIds,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
  return {
    type: "applyFileRewind",
    applied: result.applied,
    preview: result.preview,
    response: result.response,
  };
}

export const fileRewindHandlers = { applyFileRewind };
