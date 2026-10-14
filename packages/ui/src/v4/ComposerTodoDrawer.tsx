import { ArrowRightIcon, ChevronRightIcon, CircleCheckIcon, CircleIcon } from "lucide-react";
import { useState } from "react";
import type { ZCodePlanStep } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerTodoModel } from "@/v4/messageStreamTodoModel.js";

const todoTextClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

function TodoStatusIcon({ status }: { status: ZCodePlanStep["status"] }) {
  if (status === "completed") {
    return <CircleCheckIcon className="size-4 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    return <ArrowRightIcon className="size-4 shrink-0 text-foreground" />;
  }
  return <CircleIcon className="size-4 shrink-0 text-foreground-subtlest" />;
}

export function ComposerTodoDrawer({ model }: { model: ComposerTodoModel }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const title = model.activeTitle || intl.formatMessage({ id: "todo.panel.currentTask" });
  const progress = `${model.completedCount}/${model.steps.length}`;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="composer-todo-drawer"
      data-open={open ? "true" : "false"}
      className="relative z-0 -mb-7 w-full overflow-hidden rounded-t-2xl border border-border bg-[#f0f0f0] p-1 pb-7"
    >
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center gap-2 rounded-xl px-1.5 py-1 pr-1 text-left transition-colors hover:bg-hover/30"
        aria-label={intl.formatMessage({ id: "todo.panel.toggle" })}
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-foreground-subtlest transition-transform duration-300 ease-in-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{title}</span>
        <span className="shrink-0 px-1.5 font-mono text-ui-base text-foreground-subtlest">
          {progress}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-52 space-y-0.5 overflow-y-auto pt-0.5">
          {model.steps.map((step) => (
            <div key={step.id} className="flex min-w-0 items-center gap-2 rounded-xl px-1.5 py-1">
              <TodoStatusIcon status={step.status} />
              <span className={cn("min-w-0 break-words text-ui-base", todoTextClasses[step.status])}>
                {step.title}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
