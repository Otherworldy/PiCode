import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitFork, LoaderIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_SESSION_BRANCH_GRAPH_DIALOG } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { logger } from "@/logger.js";
import { SessionBranchGraphCanvas } from "./SessionBranchGraphCanvas.js";
import {
  buildSessionBranchGraph,
  buildSessionBranchGraphInputs,
  type SessionBranchGraphInput,
  type SessionBranchGraphNode,
} from "./sessionBranchGraphLayout.js";

interface SessionBranchGraphDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  activeTaskId: string | null;
  /** 未读时间从 task 行带过来，切换时才能顺手清蓝点。 */
  onSelectTask: (taskId: string, unreadAt?: number) => void;
}

export function SessionBranchGraphDialog({
  open,
  onOpenChange,
  workspaceAbsPath,
  workspaceIdentity,
  remoteSessionId,
  activeTaskId,
  onSelectTask,
}: SessionBranchGraphDialogProps) {
  const { intl } = useZCodeIntl();
  const service = useZCodeTaskService(workspaceAbsPath, remoteSessionId, workspaceIdentity);
  const [inputs, setInputs] = useState<SessionBranchGraphInput[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [partial, setPartial] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [showDeleted, setShowDeleted] = useState(true);
  // 只有四路分区都读到，才敢把「父会话缺失」当成已删除。
  const [complete, setComplete] = useState(false);
  const scopeKey = `${workspaceAbsPath}::${workspaceIdentity ?? ""}`;
  const loadedScopeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (loadedScopeKeyRef.current !== scopeKey) {
      // 换 workspace 后旧树不属于当前上下文，先清空再拉，避免短暂画出上一条 workspace 的节点。
      loadedScopeKeyRef.current = scopeKey;
      setInputs(null);
    }
    let cancelled = false;
    const scope = { workspacePath: workspaceAbsPath, workspaceIdentity };
    // 四路分区并集才是 workspace 的全部会话：只读 active 会漏掉被 pin / 归档 / 删除的分叉节点。
    // 分区失败不能当成空集，否则一条 RPC 抖动就会把整棵树砍掉。
    const load = async (): Promise<void> => {
      setLoading(true);
      setLoadFailed(false);
      const results = await Promise.allSettled([
        service.listTasks(scope),
        service.listPinnedTasks(scope),
        service.listArchivedTasks(scope),
        service.listDeletedTasks(scope),
      ]);
      if (cancelled) return;
      const tasks: ZCodeTaskMeta[] = [];
      let failedCount = 0;
      for (const result of results.slice(0, 3)) {
        if (result.status === "fulfilled") tasks.push(...result.value);
        else failedCount += 1;
      }
      const deletedResult = results[3];
      if (deletedResult.status === "rejected") {
        // 旧 Host 没有 listDeletedTasks。此时不能合成占位父节点：分不清「已删除」与「没读到」，
        // 只能诚实保留残缺图，缺失父的节点会退化成根，由顶部提示条说明。
        failedCount += 1;
        logger.warn("[SessionBranchGraphDialog] 读取已删除会话失败", deletedResult.reason);
      }
      if (failedCount >= 4) {
        setInputs(null);
        setLoadFailed(true);
        setComplete(false);
      } else {
        setInputs(
          buildSessionBranchGraphInputs({
            tasks,
            deletedTasks: deletedResult.status === "fulfilled" ? deletedResult.value : [],
          }),
        );
        setPartial(failedCount > 0);
        setComplete(failedCount === 0);
      }
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, reloadToken, service, workspaceAbsPath, workspaceIdentity]);

  // 计数看整个家族（含已删除）；渲染布局才受「显示已删除」开关影响。
  // 开关是视图筛选而不是数据变化，统计数字跟着跳会让人误以为会话消失了。
  const familyLayout = useMemo(
    () =>
      inputs
        ? buildSessionBranchGraph({
            sessions: inputs,
            focusTaskId: activeTaskId,
            showDeleted: true,
            allowPlaceholderParents: complete,
          })
        : null,
    [inputs, activeTaskId, complete],
  );
  const layout = useMemo(() => {
    if (!inputs || !familyLayout) return null;
    if (showDeleted) return familyLayout;
    return buildSessionBranchGraph({
      sessions: inputs,
      focusTaskId: activeTaskId,
      showDeleted: false,
      allowPlaceholderParents: complete,
    });
  }, [inputs, familyLayout, showDeleted, activeTaskId, complete]);

  const familyNodes = familyLayout?.nodes ?? [];
  const activeTitle = inputs?.find((input) => input.taskId === activeTaskId)?.title ?? "";
  // 占位节点不是真实会话，不应计入「已删除」统计。
  const deletedCount = familyNodes.filter((node) => node.deleted && !node.placeholder).length;
  const focusNode = familyNodes.find((node) => node.taskId === activeTaskId);
  const focusHidden = !showDeleted && focusNode?.deleted === true;

  const handleActivate = (node: SessionBranchGraphNode): void => {
    if (node.deleted) {
      toast(intl.formatMessage({ id: "sessionBranchGraph.deletedCannotOpen" }), {
        position: "bottom-center",
      });
      return;
    }
    onSelectTask(node.taskId, node.unreadAt);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid={TID_SESSION_BRANCH_GRAPH_DIALOG}
        className="flex h-[min(78vh,720px)] max-w-[min(64rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "sessionBranchGraph.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "sessionBranchGraph.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-foreground-subtle">
              <GitFork className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-ui-base font-medium leading-tight text-foreground">
                {intl.formatMessage({ id: "sessionBranchGraph.title" })}
              </h2>
              <p className="truncate text-ui-sm text-foreground-subtlest">
                {activeTitle
                  ? intl.formatMessage(
                      { id: "sessionBranchGraph.currentSession" },
                      { title: activeTitle },
                    )
                  : intl.formatMessage({ id: "sessionBranchGraph.currentSessionUnknown" })}
                <span className="mx-1.5 opacity-40">/</span>
                {intl.formatMessage(
                  { id: "sessionBranchGraph.stats" },
                  { count: String(familyNodes.length), deleted: String(deletedCount) },
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2">
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "sessionBranchGraph.showDeleted" })}
              </span>
              <Switch
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
                aria-label={intl.formatMessage({ id: "sessionBranchGraph.showDeleted" })}
              />
            </label>
            <span className="h-4 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              aria-label={intl.formatMessage({ id: "sessionBranchGraph.refresh" })}
              disabled={loading}
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            </Button>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label={intl.formatMessage({ id: "common.close" })}
              >
                <XIcon className="size-4" />
              </Button>
            </DialogClose>
          </div>
        </div>

        <SessionBranchGraphCanvas
          layout={layout}
          activeTaskId={activeTaskId}
          fitKey={`${scopeKey}::${activeTaskId ?? ""}`}
          onActivate={handleActivate}
        >
          {loading && inputs === null ? (
            <div className="absolute inset-0 flex items-center justify-center text-foreground-subtle">
              <LoaderIcon className="size-5 animate-spin" />
            </div>
          ) : null}

          {loadFailed ? (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-ui-base text-foreground-subtle">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="break-words">
                  {intl.formatMessage({ id: "sessionBranchGraph.loadFailed" })}
                </p>
              </div>
            </div>
          ) : null}

          {partial && !loadFailed ? (
            <CanvasNotice>
              {intl.formatMessage({ id: "sessionBranchGraph.partialFailed" })}
            </CanvasNotice>
          ) : null}

          {familyLayout?.focusMissing && !loading ? (
            <CanvasNotice>
              {intl.formatMessage({ id: "sessionBranchGraph.focusMissing" })}
            </CanvasNotice>
          ) : null}

          {focusHidden ? (
            <CanvasNotice>
              {intl.formatMessage({ id: "sessionBranchGraph.focusDeleted" })}
            </CanvasNotice>
          ) : null}
        </SessionBranchGraphCanvas>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-2.5">
          <div className="flex items-center gap-3.5 text-ui-sm text-foreground-subtlest">
            <LegendItem>
              <span className="size-2.5 rounded-sm border border-brand bg-brand/10" />
              {intl.formatMessage({ id: "sessionBranchGraph.legendCurrent" })}
            </LegendItem>
            <LegendItem>
              <span className="size-1.5 rounded-full bg-success" />
              {intl.formatMessage({ id: "sessionBranchGraph.legendRunning" })}
            </LegendItem>
            <LegendItem>
              <span className="size-1.5 rounded-full bg-destructive" />
              {intl.formatMessage({ id: "sessionBranchGraph.legendError" })}
            </LegendItem>
            <LegendItem>
              <span className="size-2.5 rounded-sm border border-dashed border-foreground-subtlest" />
              {intl.formatMessage({ id: "sessionBranchGraph.legendDeleted" })}
            </LegendItem>
          </div>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "sessionBranchGraph.hint" })}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CanvasNotice({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-ui-sm text-foreground-subtle shadow-md">
      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
      {children}
    </div>
  );
}

function LegendItem({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{children}</span>;
}
