import type { CommandEnvelope, CommandResult } from "@picode/shared/picode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

async function reloadSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.reloadSession || !record.hosted) {
    throw Object.assign(new Error("This session does not support resource reload."), {
      reasonCode: "fault.command.sessionReloadUnsupported",
    });
  }
  // busy 真相归 CLI；前端可能尚未收到 running/finalization，不能在重载中途拆掉运行资源。
  if (record.activeAbortController || (record.residencyFinalizationCount ?? 0) > 0) {
    throw Object.assign(
      new Error("The session is finishing active work. Retry after it is idle."),
      {
        reasonCode: "guard.sessionReloadBusy",
      },
    );
  }
  return host.reloadSession(record.hosted.sessionId);
}

export const sessionReloadHandlers = { reloadSession };
