import { BlocksIcon } from "lucide-react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const PLAN_STATUS_KEY = "plannotator";
const PLAN_WIDGET_KEY = "plannotator-progress";

export function ExtensionChrome({
  snapshot,
  placement,
}: {
  snapshot: ConversationSnapshot | null | undefined;
  placement: "aboveEditor" | "belowEditor" | "status";
}) {
  if (placement === "status") {
    // 计划插件的状态由状态面板的 Todo 段负责，不进这堆文本。
    const statuses = (snapshot?.extensionStatuses ?? []).filter(
      (status) => status.key !== PLAN_STATUS_KEY && status.text.trim().length > 0,
    );
    if (statuses.length === 0) return null;
    return <ExtensionStatusPopup statuses={statuses} />;
  }
  const widgets = (snapshot?.extensionWidgets ?? []).filter(
    (widget) => widget.placement === placement && widget.key !== PLAN_WIDGET_KEY,
  );
  if (widgets.length === 0) return null;
  return (
    <div
      className={placement === "aboveEditor" ? "mb-2 space-y-1 text-xs" : "mt-2 space-y-1 text-xs"}
      data-testid={`pi-extension-widget-${placement}`}
    >
      {widgets.map((widget) => (
        <pre key={widget.key} className="whitespace-pre-wrap font-sans text-muted-foreground">
          {widget.lines.join("\n")}
        </pre>
      ))}
    </div>
  );
}

function ExtensionStatusPopup({
  statuses,
}: {
  statuses: ReadonlyArray<{ key: string; text: string }>;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage(
    { id: "chat.extensionStatus.label" },
    { count: String(statuses.length) },
  );
  return (
    <div className="flex shrink-0 items-center" data-testid="pi-extension-status">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="inline-flex h-6 min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-ui-caption font-normal text-foreground-subtle tabular-nums"
          >
            <BlocksIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{label}</span>
          </Button>
        </PopoverTrigger>
        {/* status 图标现在挂在输入卡下方的居中统计行里，弹层跟着改为居中展开。 */}
        <PopoverContent align="center" side="top" className="w-72 gap-0 p-1.5">
          <ul>
            {statuses.map((status) => (
              <li key={status.key} className="break-words px-2 py-1.5 text-ui-base text-foreground">
                {status.text}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
