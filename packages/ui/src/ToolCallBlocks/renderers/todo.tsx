import { ListTodoIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@picode/shared";
import type { ZCodePlanStep } from "@picode/shared";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  stripTodoStepEmphasis,
  TodoStepGlyph,
  todoStepTextClass,
} from "@/components/TodoStepGlyph.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const TODO_TOOL_ICON = <ListTodoIcon className="size-4 shrink-0 text-foreground-subtle" />;

function readTodoPlan(context: ToolCallBlockRenderContext): ZCodePlanStep[] | null {
  const { toolCall } = context.toolCallNode;
  return (
    extractPlanStepsFromToolOutput({
      title: toolCall.title,
      kind: toolCall.kind,
      output: toolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: toolCall.title,
      kind: toolCall.kind,
      input: toolCall.input,
    })
  );
}

export function TodoToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const plan = readTodoPlan(context);
  const completedCount = plan?.filter((step) => step.status === "completed").length ?? 0;
  const activeStep =
    plan?.find((step) => step.status === "in_progress") ??
    plan?.find((step) => step.status !== "completed") ??
    plan?.at(-1);
  const kindLabel = intl.formatMessage({ id: "todo.panel.title" });
  const primaryText =
    (activeStep ? stripTodoStepEmphasis(activeStep.title) : null) ||
    toolCall.title ||
    intl.formatMessage({ id: "todo.panel.currentTask" });
  const secondaryText = plan ? `${completedCount}/${plan.length}` : context.statusLabel;
  const primaryTextNode = useMemo(
    () => <span className="min-w-0 truncate text-foreground-subtlest">{primaryText}</span>,
    [primaryText],
  );
  const secondaryTextNode = useMemo(
    () => (
      <span className="shrink-0 font-mono text-ui-base text-foreground-subtlest">
        {secondaryText}
      </span>
    ),
    [secondaryText],
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () =>
      plan ? (
        <div className="space-y-1 rounded-xl bg-surface px-3 py-2">
          {plan.map((step) => {
            const stepText = stripTodoStepEmphasis(step.title);
            return (
              <div key={step.id} className="flex min-w-0 items-center gap-2 py-1">
                <TodoStepGlyph status={step.status} />
                <span
                  className={cn("min-w-0 break-words text-ui-base", todoStepTextClass(step.status))}
                >
                  {stepText}
                </span>
              </div>
            );
          })}
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </div>
      ) : (
        <>
          <ToolCallBody
            childToolList={context.childToolList}
            displayModel={context.displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </>
      ),
    [
      context.childToolList,
      context.codePreviewSettings,
      context.displayModel,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      handleLoadFullToolCallFields,
      plan,
      toolCall,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={TODO_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={kindLabel}
      sourceLabel={context.sourceLabel}
      primaryText={primaryTextNode}
      secondaryText={secondaryTextNode}
      statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
