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
    return <CircleCheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    return <ArrowRightIcon className="size-3.5 shrink-0 text-foreground" />;
  }
  return <CircleIcon className="size-3.5 shrink-0 text-foreground-subtlest" />;
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
      className="w-full"
    >
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center gap-2 px-1.5 py-1 text-left"
        aria-label={intl.formatMessage({ id: "todo.panel.toggle" })}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-foreground-subtle transition-transform duration-300 ease-in-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{title}</span>
        <span className="shrink-0 font-mono text-ui-base text-foreground-subtlest">{progress}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-52 space-y-1 overflow-y-auto px-1.5 pt-1 pb-0.5">
          {model.steps.map((step) => (
            <div key={step.id} className="flex min-w-0 items-center gap-2 py-1">
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
