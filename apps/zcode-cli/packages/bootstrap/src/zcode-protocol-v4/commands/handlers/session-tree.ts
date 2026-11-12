import { sessionIdOf } from "../../../zcode-protocol/session-owner.js";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

function unsupported(): Error {
  return Object.assign(new Error("Session tree is unavailable"), {
    reasonCode: "fault.command.sessionTreeUnsupported",
  });
}

async function readSessionTree(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.readSessionTree) throw unsupported();
  return host.readSessionTree(sessionIdOf(record));
}

async function navigateSessionTree(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.navigateSessionTree) throw unsupported();
  const payload = envelope.payload as CommandPayloadMap["navigateSessionTree"];
  return host.navigateSessionTree(sessionIdOf(record), payload);
}

async function labelSessionEntry(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.labelSessionEntry) throw unsupported();
  const payload = envelope.payload as CommandPayloadMap["labelSessionEntry"];
  return host.labelSessionEntry(sessionIdOf(record), payload);
}

async function deleteSessionBranch(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.deleteSessionBranch) throw unsupported();
  const payload = envelope.payload as CommandPayloadMap["deleteSessionBranch"];
  return host.deleteSessionBranch(sessionIdOf(record), payload);
}

export const sessionTreeHandlers = {
  readSessionTree,
  navigateSessionTree,
  labelSessionEntry,
  deleteSessionBranch,
};
