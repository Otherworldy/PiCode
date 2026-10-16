import { useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { XIcon } from "lucide-react";

/** 扩展命令的 notify。关弹窗只收起这一次输出，不写进对话。 */
export function ExtensionCommandChrome({ snapshot }: { snapshot: ConversationSnapshot }) {
  const [hiddenNoticeId, setHiddenNoticeId] = useState<string | null>(null);
  const notice = snapshot.extensionNotice ?? null;
  if (!notice || notice.id === hiddenNoticeId) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setHiddenNoticeId(notice.id);
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
            onClick={() => setHiddenNoticeId(notice.id)}
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
