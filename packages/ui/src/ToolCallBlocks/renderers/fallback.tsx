import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { readUnknownToolResult, summarizeUnknownToolInput } from "./fallback-summary.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  /** 摘要行 kind 文案后的附加标记（如后台派发角标）。 */
  kindDetail?: ReactNode;
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
  /** 传 `null` 表示这张卡不要主文本（摘要行只留 kind 文案与状态），缺省沿用兜底文案。 */
  primaryTextOverride?: ReactNode;
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreview = displayModel.inlinePreview.type !== "none";
  const summary = summarizeUnknownToolInput(toolCall.input);
  const resultText = hasInlinePreview ? undefined : readUnknownToolResult(toolCall.output);
  const visibleError = toolCall.status === "failed" ? (toolCall.error ?? errorText) : undefined;
  const detailsLabel = intl.formatMessage({ id: "chat.toolCall.mcp.callDetails" });
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <div className="mb-2 space-y-3 py-1">
        {childToolList}
        {hasInlinePreview ? (
          <ToolCallBody
            childToolList={null}
            displayModel={{ ...displayModel, showInput: false, showKind: false, showOutput: false }}
            toolCall={toolCall}
            workspacePath={workspacePath}
            theme={theme}
            codePreviewSettings={codePreviewSettings}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenBrowserUrl={onOpenBrowserUrl}
          />
        ) : null}
        {visibleError ? (
          <p className="whitespace-pre-wrap break-words rounded-xl bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
            {visibleError}
          </p>
        ) : resultText ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-card px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
            {resultText}
          </pre>
        ) : null}
        {toolCall.input !== undefined ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {detailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-card px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </div>
    ),
    [
      childToolList,
      codePreviewSettings,
      detailsLabel,
      displayModel,
      handleLoadFullToolCallFields,
      hasInlinePreview,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      resultText,
      theme,
      toolCall,
      visibleError,
      workspacePath,
    ],
  );

  const titled = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const primary =
    summary ??
    (titled || intl.formatMessage({ id: "chat.toolCall.toolCall" }));
  const primaryTextOverride = context.primaryTextOverride;

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      kindDetail={context.summaryOnly ? undefined : context.kindDetail}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly ? (
          (context.summaryTextOverride ?? null)
        ) : primaryTextOverride !== undefined ? (
          primaryTextOverride
        ) : (
          <span className="truncate">{primary}</span>
        )
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        primaryTextOverride !== undefined
          ? typeof primaryTextOverride === "string"
            ? primaryTextOverride
            : undefined
          : context.summaryOnly && typeof context.summaryTextOverride === "string"
            ? context.summaryTextOverride
            : primary
      }
      renderContent={renderContent}
    />
  );
}
