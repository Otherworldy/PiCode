import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export function ExtensionChrome({
  snapshot,
  placement,
}: {
  snapshot: ConversationSnapshot | null | undefined;
  placement: "aboveEditor" | "belowEditor" | "status";
}) {
  if (placement === "status") {
    const statuses = snapshot?.extensionStatuses ?? [];
    if (statuses.length === 0) return null;
    return (
      <div className="mb-2 flex flex-wrap gap-1 text-xs text-muted-foreground" data-testid="pi-extension-status">
        {statuses.map((status) => (
          <span key={status.key} className="rounded bg-muted px-1.5 py-0.5">
            {status.text}
          </span>
        ))}
      </div>
    );
  }
  const widgets = (snapshot?.extensionWidgets ?? []).filter((widget) => widget.placement === placement);
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
