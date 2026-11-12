import type { HostedSession } from "@picode/pi-host";
import type { ZCodeApp } from "../app/types.js";

export type SessionOwner = (
  | { hosted: HostedSession; app?: never }
  | { hosted?: never; app: ZCodeApp }
) & {
  persistMode?: (mode: string) => Promise<void>;
  persistSession?: (title: string) => Promise<void>;
  abortWork?: (workId: string) => Promise<boolean>;
};

/** 旧 Core 能力必须显式拒绝 Pi，不能把 HostedSession 伪装成 runtime。 */
export function legacyApp(record: SessionOwner): ZCodeApp {
  if (record.hosted)
    throw Object.assign(new Error("This session does not support the requested Core capability"), {
      reasonCode: "fault.command.capabilityUnsupported",
    });
  return record.app;
}

export function sessionIdOf(record: SessionOwner): string {
  return record.hosted ? record.hosted.sessionId : record.app.sessionId;
}
