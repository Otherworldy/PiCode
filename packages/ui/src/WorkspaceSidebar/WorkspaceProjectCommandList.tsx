import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export function WorkspaceProjectCommandList({
  creating,
  directory,
  failed,
  files,
  loading,
  newName,
  onCreate,
  onDelete,
  onNameChange,
  onOpen,
  onStartCreate,
  onStopCreate,
  saving,
  selected,
}: {
  creating: boolean;
  directory: string;
  failed: boolean;
  files: string[];
  loading: boolean;
  newName: string;
  onCreate: () => void;
  onDelete: (name: string) => void;
  onNameChange: (name: string) => void;
  onOpen: (name: string) => void;
  onStartCreate: () => void;
  onStopCreate: () => void;
  saving: boolean;
  selected: string | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="truncate font-mono text-ui-sm text-foreground-subtle" title={directory}>
          .pi/prompts ({files.length})
        </span>
        <Button
          disabled={loading || saving}
          onClick={onStartCreate}
          size="lg"
          type="button"
          variant="outline"
          className="gap-1.5"
        >
          <Plus className="size-4" />
          {intl.formatMessage({ id: "settings.systemPrompt.new" })}
        </Button>
      </div>
      {creating ? (
        <div className="border-b border-border p-2">
          <Input
            size="lg"
            aria-label={intl.formatMessage({ id: "settings.systemPrompt.newPlaceholder" })}
            autoFocus
            disabled={saving}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCreate();
              }
              if (event.key === "Escape") onStopCreate();
            }}
            placeholder={intl.formatMessage({ id: "settings.systemPrompt.newPlaceholder" })}
            value={newName}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
        {failed ? (
          <p className="px-2 py-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPrompt.loadFailed" })}
          </p>
        ) : files.length === 0 && !loading ? (
          <p className="px-2 py-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPrompt.empty" })}
          </p>
        ) : (
          files.map((name) => (
            <div
              key={name}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1",
                name === selected ? "bg-surface-hover" : "hover:bg-surface-hover",
              )}
            >
              <button
                className={cn(
                  "min-w-0 flex-1 truncate px-2 py-1 text-left font-mono text-ui-sm",
                  name === selected ? "text-foreground" : "text-foreground-subtle",
                )}
                disabled={loading || saving}
                onClick={() => onOpen(name)}
                type="button"
              >
                {name}
              </button>
              <Button
                className="opacity-0 group-hover:opacity-100"
                disabled={saving}
                onClick={() => onDelete(name)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X className="size-3.5" />
                <span className="sr-only">
                  {intl.formatMessage({ id: "settings.systemPrompt.delete" })}
                </span>
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
