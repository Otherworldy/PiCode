import { useEffect, useState } from "react";
import { GitFork } from "lucide-react";
import { TID_SESSION_BRANCH_GRAPH_TOGGLE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { SessionBranchGraphDialog } from "./SessionBranchGraphDialog.js";

/**
 * 会话分支图谱入口。
 *
 * 弹窗与按钮同组件挂载：和 GitBranchSwitcher 里的 GitGraphDialog 一致，
 * 避免为单个弹窗往 app-shell 加应用级 dialog 宿主。
 */
export function SessionBranchGraphButton({
  workspaceAbsPath,
  workspaceIdentity,
  remoteSessionId,
  activeTaskId,
  onSelectTask,
  useWindowsCaptionSpacing = false,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  activeTaskId: string | null;
  onSelectTask: (taskId: string, unreadAt?: number) => void;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({ id: "sessionBranchGraph.toggle" });
  // 图谱范围由当前会话决定，草稿态没有可展开的分叉树。
  const disabledReason = activeTaskId
    ? undefined
    : intl.formatMessage({ id: "sessionBranchGraph.disabledNoSession" });

  // 当前会话被其它窗口删掉时 dialog 会卸载，open 必须跟着回到关闭，
  // 否则下次选中任何会话都会自己弹出来。
  useEffect(() => {
    if (!activeTaskId) setOpen(false);
  }, [activeTaskId]);

  return (
    <>
      <ControlHintTooltip title={disabledReason ?? label} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          data-testid={TID_SESSION_BRANCH_GRAPH_TOGGLE}
          className={cn(
            "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
            useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
            open && "!bg-selected text-foreground",
          )}
          aria-label={label}
          disabled={Boolean(disabledReason)}
          onClick={() => setOpen(true)}
        >
          <GitFork className="size-4" />
        </Button>
      </ControlHintTooltip>
      {activeTaskId ? (
        <SessionBranchGraphDialog
          open={open}
          onOpenChange={setOpen}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          activeTaskId={activeTaskId}
          onSelectTask={onSelectTask}
        />
      ) : null}
    </>
  );
}
