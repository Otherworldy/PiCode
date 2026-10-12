import type { ZCodePiPluginsResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type PiPluginConfig = NonNullable<ZCodePiPluginsResult["configs"]>[number];
type PiPluginConfigValue = PiPluginConfig["fields"][number]["value"];

export function PiPluginConfigDialog({
  editing,
  draft,
  saving,
  onOpenChange,
  onDraft,
  onSave,
}: {
  editing: PiPluginConfig | null;
  draft: Record<string, PiPluginConfigValue>;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onDraft: (key: string, value: PiPluginConfigValue) => void;
  onSave: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing?.name}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.plugins.pi.configHint" })}
          </DialogDescription>
        </DialogHeader>
        {editing && editing.skipped.length > 0 ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.pi.configSkipped" },
              { keys: editing.skipped.join(", ") },
            )}
          </div>
        ) : null}
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
          {editing?.fields.map((field) => (
            <label key={field.key} className="grid gap-1 text-ui-base text-foreground">
              <span className="text-foreground-subtle">{field.key}</span>
              {field.type === "boolean" ? (
                <Switch
                  checked={draft[field.key] === true}
                  disabled={saving}
                  onCheckedChange={(checked) => onDraft(field.key, checked)}
                />
              ) : (
                <Input
                  type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"}
                  size="sm"
                  className="h-8"
                  value={String(draft[field.key] ?? "")}
                  disabled={saving}
                  onChange={(event) => {
                    const next =
                      field.type === "number" ? Number(event.target.value) : event.target.value;
                    if (typeof next === "number" && !Number.isFinite(next)) return;
                    onDraft(field.key, next);
                  }}
                />
              )}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" disabled={saving || !editing} onClick={onSave}>
            {intl.formatMessage({ id: "settings.plugins.pi.configSave" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
