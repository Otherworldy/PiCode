import { Download } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginAvatarPlaceholder, PluginKindBadge } from "@/settings/PiPluginCardVisuals.js";

type InstalledPlugin = {
  id: string;
  kind: string;
  name: string;
  detail: string;
  enabled: boolean;
};

export function PiPluginInstalledCards({
  plugins,
  pendingId,
  hasUpdate,
  hasConfig,
  onUpdate,
  onConfigure,
  onRemove,
  onToggle,
}: {
  plugins: readonly InstalledPlugin[];
  pendingId: string | null;
  hasUpdate: (id: string) => boolean;
  hasConfig: (id: string) => boolean;
  onUpdate: (id: string) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1500px]:grid-cols-4">
      {plugins.map((plugin) => (
        <div
          key={plugin.id}
          className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-brand/40"
        >
          <div className="flex gap-3">
            <PluginAvatarPlaceholder name={plugin.name} kind={plugin.kind} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-mono text-ui-sm font-semibold text-foreground">
                  {plugin.name}
                </div>
                {hasUpdate(plugin.id) ? (
                  <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.2 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                    Update
                  </span>
                ) : plugin.enabled ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                  </span>
                ) : null}
              </div>
              {plugin.detail ? (
                <p className="mt-1 line-clamp-2 text-ui-sm leading-5 text-foreground-subtle">
                  {plugin.detail}
                </p>
              ) : null}
              <div className="mt-2">
                <PluginKindBadge
                  kind={plugin.kind}
                  label={intl.formatMessage({
                    id:
                      plugin.kind === "extension"
                        ? "settings.plugins.pi.kind.extension"
                        : "settings.plugins.pi.kind.package",
                  })}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border pt-2">
            {hasUpdate(plugin.id) ? (
              <Button
                type="button"
                size="default"
                disabled={pendingId === plugin.id}
                onClick={() => onUpdate(plugin.id)}
              >
                <Download />
                {intl.formatMessage({ id: "settings.plugins.pi.update" })}
              </Button>
            ) : null}
            {hasConfig(plugin.id) ? (
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => onConfigure(plugin.id)}
              >
                {intl.formatMessage({ id: "settings.plugins.pi.configure" })}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              size="default"
              disabled={pendingId === plugin.id}
              onClick={() => onRemove(plugin.id)}
            >
              {intl.formatMessage({ id: "settings.plugins.pi.remove" })}
            </Button>
            <Switch
              checked={plugin.enabled}
              disabled={pendingId === plugin.id}
              data-testid={`pi-plugin-switch-${plugin.kind}`}
              onCheckedChange={(enabled) => onToggle(plugin.id, enabled)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
