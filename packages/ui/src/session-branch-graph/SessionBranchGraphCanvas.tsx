import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MinusIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { TID_SESSION_BRANCH_GRAPH_NODE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  SESSION_BRANCH_GRAPH_NODE_HEIGHT,
  SESSION_BRANCH_GRAPH_NODE_WIDTH,
  type SessionBranchGraphLayout,
  type SessionBranchGraphNode,
} from "./sessionBranchGraphLayout.js";

const MIN_SCALE = 0.4;
const MAX_SCALE = 2;
const FIT_PADDING = 24;

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

/**
 * 分支图谱画布：只负责把布局画出来并处理缩放/平移/悬停高亮。
 * 数据来源与错误态由弹窗持有，画布不碰服务。
 */
export function SessionBranchGraphCanvas({
  layout,
  activeTaskId,
  fitKey,
  onActivate,
  children,
}: {
  layout: SessionBranchGraphLayout | null;
  activeTaskId: string | null;
  /** 只在换 workspace / 换聚焦会话时重新适配视图；切「显示已删除」保留用户缩放。 */
  fitKey: string;
  onActivate: (node: SessionBranchGraphNode) => void;
  /** 绝对定位的浮层：加载中、读取不完整、聚焦会话缺失等。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const applyFit = useCallback((target: SessionBranchGraphLayout | null) => {
    const element = viewportRef.current;
    if (!target || !element) return;
    const fitted = Math.min(
      (element.clientWidth - FIT_PADDING) / target.width,
      (element.clientHeight - FIT_PADDING) / target.height,
      1,
    );
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitted));
    setView({
      scale,
      x: (element.clientWidth - target.width * scale) / 2,
      y: (element.clientHeight - target.height * scale) / 2,
    });
  }, []);

  useEffect(() => {
    if (!layout) return;
    // 同一个聚焦会话下只在首次拿数据时适配；之后切开关或刷新都保留用户当前视角。
    if (fittedKeyRef.current === fitKey) return;
    fittedKeyRef.current = fitKey;
    // 首帧才拿得到真实视口尺寸，适配放到下一帧。
    const frame = requestAnimationFrame(() => applyFit(layout));
    return () => cancelAnimationFrame(frame);
  }, [layout, fitKey, applyFit]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((previous) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous.scale * factor));
        const ratio = scale / previous.scale;
        return {
          scale,
          x: pointerX - (pointerX - previous.x) * ratio,
          y: pointerY - (pointerY - previous.y) * ratio,
        };
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const relatedTaskIds = useMemo(() => {
    if (!layout || !hoveredTaskId) return null;
    const related = new Set<string>([hoveredTaskId]);
    let parentId = layout.parentByTaskId.get(hoveredTaskId);
    while (parentId) {
      related.add(parentId);
      parentId = layout.parentByTaskId.get(parentId);
    }
    const stack = [hoveredTaskId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const childId of layout.childIdsByTaskId.get(current) ?? []) {
        related.add(childId);
        stack.push(childId);
      }
    }
    return related;
  }, [layout, hoveredTaskId]);

  const zoomBy = (factor: number): void => {
    const element = viewportRef.current;
    if (!element) return;
    const centerX = element.clientWidth / 2;
    const centerY = element.clientHeight / 2;
    setView((previous) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous.scale * factor));
      const ratio = scale / previous.scale;
      return {
        scale,
        x: centerX - (centerX - previous.x) * ratio,
        y: centerY - (centerY - previous.y) * ratio,
      };
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 节点与缩放条自己消费指针，拖拽只从空白画布开始。
    if (
      target.closest("[data-branch-graph-node]") ||
      target.closest("[data-branch-graph-control]")
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((previous) => ({
      ...previous,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    }));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // pointercancel 后浏览器已隐式释放捕获，重复释放会抛 NotFoundError。
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 cursor-grab select-none overflow-hidden bg-surface active:cursor-grabbing"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={layout?.width ?? 0}
          height={layout?.height ?? 0}
          aria-hidden="true"
        >
          {(layout?.edges ?? []).map((edge) => {
            const isActive =
              relatedTaskIds !== null &&
              relatedTaskIds.has(edge.fromTaskId) &&
              relatedTaskIds.has(edge.toTaskId);
            return (
              <path
                key={`${edge.fromTaskId}->${edge.toTaskId}`}
                d={edge.path}
                fill="none"
                strokeWidth={isActive ? 2 : 1.5}
                strokeDasharray={edge.indirect ? "4 4" : undefined}
                className={cn("transition-colors", isActive ? "stroke-brand" : "stroke-border")}
              />
            );
          })}
        </svg>

        {(layout?.nodes ?? []).map((node) => {
          const isCurrent = node.taskId === activeTaskId;
          const isDimmed = relatedTaskIds !== null && !relatedTaskIds.has(node.taskId);
          const title =
            node.title || intl.formatMessage({ id: "sessionBranchGraph.placeholderTitle" });
          // aria-label 会盖掉节点正文，状态和「当前」必须显式拼进去。
          const accessibleLabel = [
            title,
            isCurrent ? intl.formatMessage({ id: "sessionBranchGraph.current" }) : "",
            node.deleted
              ? intl.formatMessage({ id: "sessionBranchGraph.deleted" })
              : node.status === "running"
                ? intl.formatMessage({ id: "sessionBranchGraph.running" })
                : node.status === "error"
                  ? intl.formatMessage({ id: "sessionBranchGraph.error" })
                  : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <ControlHintTooltip key={node.taskId} title={title} side="top">
              <button
                type="button"
                data-branch-graph-node
                data-testid={TID_SESSION_BRANCH_GRAPH_NODE}
                data-task-id={node.taskId}
                tabIndex={node.deleted ? -1 : 0}
                aria-disabled={node.deleted || undefined}
                aria-label={accessibleLabel}
                className={cn(
                  "absolute flex flex-col justify-center gap-1 rounded-xl border border-border bg-card px-2.5 py-2 text-left transition-colors",
                  "hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  isCurrent && "border-brand bg-brand/5 ring-1 ring-brand/30",
                  // 画布底色本身就是 surface，已删除节点保持卡片底色，只靠虚线边框与弱化标题区分。
                  node.deleted && "cursor-default border-dashed hover:border-border",
                  isDimmed && "opacity-40",
                )}
                style={{
                  left: node.left,
                  top: node.top,
                  width: SESSION_BRANCH_GRAPH_NODE_WIDTH,
                  height: SESSION_BRANCH_GRAPH_NODE_HEIGHT,
                }}
                onPointerEnter={() => setHoveredTaskId(node.taskId)}
                onPointerLeave={() =>
                  setHoveredTaskId((previous) => (previous === node.taskId ? null : previous))
                }
                onFocus={() => setHoveredTaskId(node.taskId)}
                onBlur={() =>
                  setHoveredTaskId((previous) => (previous === node.taskId ? null : previous))
                }
                onClick={() => onActivate(node)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full bg-foreground-subtlest",
                      node.status === "running" && "bg-success",
                      node.status === "error" && "bg-destructive",
                      node.deleted && "border border-foreground-subtlest bg-transparent",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-ui-base font-medium text-foreground",
                      node.deleted && "text-foreground-subtle",
                    )}
                  >
                    {title}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ui-sm text-foreground-subtlest">
                    {formatTaskRelativeTime(node.updatedAt, intl)}
                  </span>
                  <NodeBadge node={node} isCurrent={isCurrent} />
                </span>
              </button>
            </ControlHintTooltip>
          );
        })}
      </div>

      {children}

      <div
        data-branch-graph-control
        className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "sessionBranchGraph.zoomOut" })}
          onClick={() => zoomBy(1 / 1.2)}
        >
          <MinusIcon className="size-3.5" />
        </Button>
        <span className="w-11 text-center text-ui-base text-foreground-subtle tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "sessionBranchGraph.zoomIn" })}
          onClick={() => zoomBy(1.2)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={() => applyFit(layout)}
        >
          {intl.formatMessage({ id: "sessionBranchGraph.fit" })}
        </Button>
      </div>
    </div>
  );
}

/** 节点右下角状态标记；文字与颜色同时表达，不靠颜色单独区分。 */
function NodeBadge({ node, isCurrent }: { node: SessionBranchGraphNode; isCurrent: boolean }) {
  const { intl } = useZCodeIntl();
  if (isCurrent) {
    return (
      <Badge className="border-transparent bg-brand/15 text-brand">
        {intl.formatMessage({ id: "sessionBranchGraph.current" })}
      </Badge>
    );
  }
  if (node.deleted) {
    return (
      <Badge className="border-transparent bg-surface-hover text-foreground-subtlest">
        <Trash2Icon />
        {intl.formatMessage({ id: "sessionBranchGraph.deleted" })}
      </Badge>
    );
  }
  if (node.status === "running") {
    return (
      <Badge className="border-transparent bg-success/15 text-success">
        {intl.formatMessage({ id: "sessionBranchGraph.running" })}
      </Badge>
    );
  }
  if (node.status === "error") {
    return (
      <Badge className="border-transparent bg-destructive/15 text-destructive">
        {intl.formatMessage({ id: "sessionBranchGraph.error" })}
      </Badge>
    );
  }
  return null;
}
