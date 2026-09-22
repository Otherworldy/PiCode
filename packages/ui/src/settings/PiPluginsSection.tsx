import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodePiPluginsResult } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type PiPlugin = ZCodePiPluginsResult["plugins"][number];

export function PiPluginsSection({
  workspacePath,
  workspaceIdentity,
  scope,
  searchQuery,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  scope: "user" | "project";
  searchQuery: string;
}) {
  const { intl } = useZCodeIntl();
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const [plugins, setPlugins] = useState<PiPlugin[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const workspace = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const load = useCallback(async () => {
    try {
      setPlugins((await session.mutatePiPlugins({ ...workspace, action: "list" })).plugins);
    } catch (error) {
      logger.warn("[pi-plugins] load failed", { error });
      setPlugins([]);
      toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
    }
  }, [intl, session, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const needle = searchQuery.trim().toLowerCase();
  const visible = (plugins ?? []).filter((plugin) => {
    if (plugin.scope !== scope) return false;
    if (!needle) return true;
    return `${plugin.name} ${plugin.detail}`.toLowerCase().includes(needle);
  });

  return (
    <div className="mb-6">
      <div className="mb-3">
        <div className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.plugins.pi.title" })}
        </div>
        <div className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.pi.hint" })}
        </div>
      </div>
      {plugins === null ? (
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.pi.loading" })}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.pi.empty" })}
        </div>
      ) : (
        <SettingsGroupCard>
          {visible.map((plugin) => (
            <SettingsRow
              key={plugin.id}
              label={plugin.name}
              description={plugin.detail}
              control={
                <Switch
                  checked={plugin.enabled}
                  disabled={pendingId === plugin.id}
                  data-testid={`pi-plugin-switch-${plugin.kind}`}
                  onCheckedChange={(enabled) => {
                    setPendingId(plugin.id);
                    void session
                      .mutatePiPlugins({
                        ...workspace,
                        action: "setEnabled",
                        id: plugin.id,
                        enabled,
                      })
                      .then((result) => setPlugins(result.plugins))
                      .catch((error) => {
                        logger.warn("[pi-plugins] toggle failed", { error });
                        toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
                      })
                      .finally(() => setPendingId(null));
                  }}
                />
              }
            />
          ))}
        </SettingsGroupCard>
      )}
    </div>
  );
}
