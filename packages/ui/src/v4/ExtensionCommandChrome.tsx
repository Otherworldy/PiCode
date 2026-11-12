import { useState } from "react";
import type { ConversationSnapshot } from "@picode/shared/picode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { XIcon } from "lucide-react";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { logger } from "@/logger.js";

/**
 * 扩展命令的 notify。关弹窗只收起这一次输出，不写进对话。
 *
 * 关掉要交回宿主：快照是这条回执的所有者，只在本组件记「已关」的话，切走会话
 * 再切回来组件重挂，快照里那条照旧会再弹一次。收起是本地乐观反馈，命令失败不重开。
 */
export function ExtensionCommandChrome({ snapshot }: { snapshot: ConversationSnapshot }) {
  const { sendCommand } = useV4Conversation();
  const [hiddenNoticeId, setHiddenNoticeId] = useState<string | null>(null);
  const notice = snapshot.extensionNotice ?? null;
  if (!notice || notice.id === hiddenNoticeId) return null;
  const dismiss = () => {
    setHiddenNoticeId(notice.id);
    void sendCommand(
      createCommandEnvelope({
        type: "dismissExtensionNotice",
        sessionId: snapshot.sessionId,
        payload: { noticeId: notice.id },
      }),
    )
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
          logger.debug("[extension-command] dismissExtensionNotice 被拒绝", {
            noticeId: notice.id,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
      })
      .catch((error: unknown) => {
        logger.debug("[extension-command] dismissExtensionNotice 失败", {
          noticeId: notice.id,
          error,
        });
      });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-2xl">
        <DialogHeader className="flex-row items-center justify-between gap-2">
          <DialogTitle>/{notice.command || "command"}</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="shrink-0 rounded-xl"
            onClick={dismiss}
          >
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap font-sans text-ui-base text-foreground">
          {notice.text}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
