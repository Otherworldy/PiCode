import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * ZCodePlanStep 用 `in_progress`，V4 快照的 PlanItem 用 `inProgress`；
 * 展示层把两种拼写当成同一个状态，不要求调用方转写。
 */
export type TodoStepStatus = "pending" | "in_progress" | "inProgress" | "completed";

function isRunning(status: TodoStepStatus): boolean {
  return status === "in_progress" || status === "inProgress";
}

/**
 * 待办步骤的状态图形：完成=实心勾圆点，进行中=细环+呼吸弧，待办=细空心环。
 * 三种形状都落在 14px 的同一格里，行首才能连成一条竖线。
 * 图形本身对读屏器暴露一句状态词：行内文字只承载标题，状态靠颜色和删除线
 * 表达，不再补一句就会对辅助技术完全不可见。
 */
export function TodoStepGlyph({
  status,
  className,
}: {
  status: TodoStepStatus;
  className?: string;
}): ReactNode {
  const { intl } = useZCodeIntl();
  const ariaLabel = intl.formatMessage({
    id:
      status === "completed"
        ? "todo.step.statusCompleted"
        : status === "pending"
          ? "todo.step.statusPending"
          : "todo.step.statusInProgress",
  });

  if (status === "completed") {
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground",
          className,
        )}
      >
        <CheckIcon aria-hidden className="size-2" strokeWidth={4} />
      </span>
    );
  }
  if (isRunning(status)) {
    // 细环 + 呼吸弧：轨道很淡，扫过的那段弧用正文色，比待办的灰环更重，
    // 一眼能分出「在跑」和「没开始」。减少动效时停在静态弧上。
    // viewBox 取 14 而不是 16：2r + strokeWidth = 14，外径和待办的空心环完全重合。
    return (
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox="0 0 14 14"
        className={cn("size-3.5 shrink-0 text-foreground", className)}
      >
        <g className="todo-step-spin">
          <circle
            cx="7"
            cy="7"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.2"
          />
          <circle
            cx="7"
            cy="7"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="todo-step-arc"
          />
        </g>
      </svg>
    );
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn(
        "size-3.5 shrink-0 rounded-full border-[1.5px] border-foreground-subtle",
        className,
      )}
    />
  );
}

/** 与状态匹配的文字样式；完成项降级并加删除线，进行中用正文色。 */
export function todoStepTextClass(status: TodoStepStatus): string {
  if (status === "completed") return "text-foreground-subtlest line-through";
  if (isRunning(status)) return "text-foreground";
  return "text-foreground-subtle";
}

/**
 * 模型习惯把整行写成 `**Step 1: …**`，列表行本身已有字号和颜色层级，
 * 强调符号只会变成字面量噪声。只清行内成对强调标记，不碰单个 `*` / `_`
 * （会和 `*.ts`、`snake_case` 撞），也不解析标题、列表和代码块。
 * 两条额外约束：
 * - 加粗对里面不允许再出现 `*`，否则 glob 里的双星会先被配对，
 *   把路径和后面的强调一起吃坏。
 * - 加粗对内容不能是纯 ASCII 标识符（否则 `__init__` 会被当成强调剥掉），
 *   但允许中文（`__注意__`）。
 */
export function stripTodoStepEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/(^|\W)__(?![A-Za-z0-9]+__)([^_]+)__(?=\W|$)/g, "$1$2")
    .trim();
}
