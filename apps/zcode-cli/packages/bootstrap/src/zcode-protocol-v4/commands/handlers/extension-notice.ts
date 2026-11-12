// 扩展命令回执弹窗：dismissExtensionNotice。
//
// 弹窗内容（`snapshot.extensionNotice`）的所有者是会话投影，客户端不另存一份「已关」。
// 只在前端关掉的话，切走会话再切回来页面重挂，快照里那条回执照样会再弹一次。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/** 宿主拿得出这条回执就收掉它；已经没有（重复关闭 / 已换成别的回执）是无害幂等。 */
async function dismissExtensionNotice(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["dismissExtensionNotice"];
  const record = requireRecord(host, envelope.sessionId);
  const hosted = record.hosted;
  if (!hosted?.dismissExtensionNotice) {
    throw Object.assign(new Error("Extension notice is unavailable"), {
      reasonCode: "fault.command.extensionNoticeUnsupported",
    });
  }
  if (!hosted.dismissExtensionNotice(payload.noticeId)) {
    host.logger?.info?.("v4 dismissExtensionNotice no matching notice (idempotent)", {
      event: "zcode_protocol.v4.extension_notice_already_dismissed",
      noticeId: payload.noticeId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

export const extensionNoticeHandlers = { dismissExtensionNotice };
