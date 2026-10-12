import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ZCodePiPluginsResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { piPluginUpdateWorkspaceKey } from "@/lib/piPluginUpdateCheck.js";
import { logger } from "@/logger.js";
import { PiPluginConfigDialog } from "@/settings/PiPluginConfigDialog.js";
import { PiPluginInstalledCards } from "@/settings/PiPluginInstalledCards.js";
import { PiPluginMarket } from "@/settings/PiPluginMarket.js";
import { PiPluginToolNotice } from "@/settings/PiPluginToolNotice.js";
import { usePiPluginUpdateStore } from "@/store/piPluginUpdateStore.js";

type PiPlugin = ZCodePiPluginsResult["plugins"][number];
type PiPluginConfig = NonNullable<ZCodePiPluginsResult["configs"]>[number];
type PiPluginConfigValue = PiPluginConfig["fields"][number]["value"];

function draftOf(config: PiPluginConfig): Record<string, PiPluginConfigValue> {
  return Object.fromEntries(config.fields.map((field) => [field.key, field.value]));
}

function namesOf(plugin: PiPlugin): Set<string> {
  const keys = new Set<string>();
  const push = (value: string) => {
    const lower = value.trim().toLowerCase();
    if (!lower) return;
    keys.add(lower);
    const bare = lower.replace(/^pi-/u, "");
    keys.add(bare);
    if (bare.endsWith("s")) keys.add(bare.slice(0, -1));
  };
  push(plugin.name);
  push(
    plugin.detail
      .split(/[\\/:@]/u)
      .filter(Boolean)
      .at(-1) ?? "",
  );
  return keys;
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 1) return 2;
  let changes = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    changes += 1;
    if (changes > 1) return 2;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return changes + (left.length - i) + (right.length - j);
}

function configFor(plugin: PiPlugin, configs: PiPluginConfig[]): PiPluginConfig | undefined {
  const keys = namesOf(plugin);
  const exact = configs.filter((config) => {
    const id = config.id.toLowerCase();
    const bare = id.replace(/^pi-/u, "");
    return keys.has(id) || keys.has(bare) || (bare.endsWith("s") && keys.has(bare.slice(0, -1)));
  });
  if (exact.length > 0) {
    return (
      exact.find((config) => config.id.toLowerCase() === plugin.name.toLowerCase()) ?? exact[0]
    );
  }
  const near = configs.filter(
    (config) => editDistance(plugin.name.toLowerCase(), config.id.toLowerCase()) === 1,
  );
  return near.length === 1 ? near[0] : undefined;
}

export function PiPluginsSection({
  workspacePath,
  workspaceIdentity,
  scope,
  searchQuery,
  onSearchQueryChange,
  onVisibleCountChange,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  scope: "user" | "project";
  searchQuery: string;
  onSearchQueryChange?: (value: string) => void;
  onVisibleCountChange?: (count: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const [plugins, setPlugins] = useState<PiPlugin[] | null>(null);
  const [configs, setConfigs] = useState<PiPluginConfig[]>([]);
  const [editing, setEditing] = useState<PiPluginConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, PiPluginConfigValue>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [tools, setTools] = useState<{ npm: boolean; git: boolean } | null>(null);
  const workspaceKey = piPluginUpdateWorkspaceKey(workspacePath, workspaceIdentity);
  const updates = usePiPluginUpdateStore((state) =>
    state.workspaceKey === workspaceKey ? state.updates : [],
  );
  const workspace = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const load = useCallback(async () => {
    try {
      const result = await session.mutatePiPlugins({ ...workspace, action: "list" });
      setPlugins(result.plugins);
      setConfigs(result.configs ?? []);
      usePiPluginUpdateStore
        .getState()
        .apply(workspaceKey, result.updates ?? [], result.updatesCheckedAt);
    } catch (error) {
      logger.warn("[pi-plugins] load failed", { error });
      setPlugins([]);
      toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
    }
  }, [intl, session, workspace, workspaceKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    session
      .mutatePiPlugins({ ...workspace, action: "prerequisites" })
      .then((result) => {
        if (!cancelled) setTools(result.tools ?? null);
      })
      .catch((error) => {
        logger.warn("[pi-plugins] tool check failed", { error });
      });
    return () => {
      cancelled = true;
    };
  }, [session, workspace]);

  const needle = searchQuery.trim().toLowerCase();
  const visible = (plugins ?? []).filter((plugin) => {
    if (plugin.scope !== scope) return false;
    if (!needle) return true;
    return `${plugin.name} ${plugin.detail}`.toLowerCase().includes(needle);
  });
  useEffect(() => {
    onVisibleCountChange?.(visible.length);
  }, [onVisibleCountChange, visible.length]);

  const checkUpdates = useCallback(() => {
    setChecking(true);
    void session
      .mutatePiPlugins({ ...workspace, action: "checkUpdates" })
      .then((result) => {
        const found = result.updates ?? [];
        const count = found.filter((item) => item.scope === scope).length;
        setPlugins(result.plugins);
        setConfigs(result.configs ?? []);
        usePiPluginUpdateStore.getState().apply(workspaceKey, found, result.updatesCheckedAt);
        toast(
          intl.formatMessage(
            {
              id:
                count > 0
                  ? "settings.plugins.checkForUpdates.found"
                  : "settings.plugins.checkForUpdates.none",
            },
            { count },
          ),
        );
      })
      .catch((error) => {
        logger.warn("[pi-plugins] update check failed", { error });
        toast(intl.formatMessage({ id: "settings.plugins.pi.checkFailed" }));
      })
      .finally(() => setChecking(false));
  }, [intl, scope, session, workspace, workspaceKey]);

  return (
    <div className="mb-6 space-y-4">
      <PiPluginToolNotice tools={tools ?? null} />
      {plugins !== null ? (
        <PiPluginMarket
          plugins={plugins}
          scope={scope}
          onSearchQueryChange={onSearchQueryChange}
          installedOnly={installedOnly}
          onInstalledOnlyChange={setInstalledOnly}
          installedPanel={
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.plugins.pi.hint" })}
                </span>
                <Button type="button" size="default" disabled={checking} onClick={checkUpdates}>
                  <RefreshCw />
                  {intl.formatMessage({ id: "settings.plugins.checkForUpdates" })}
                </Button>
              </div>
              {visible.length === 0 ? (
                <div className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.plugins.pi.empty" })}
                </div>
              ) : (
                <PiPluginInstalledCards
                  plugins={visible}
                  pendingId={pendingId}
                  hasUpdate={(id) => updates.some((item) => item.id === id && item.scope === scope)}
                  hasConfig={(id) => {
                    const plugin = visible.find((item) => item.id === id);
                    return (
                      scope === "user" &&
                      plugin !== undefined &&
                      configFor(plugin, configs) !== undefined
                    );
                  }}
                  onUpdate={(id) => {
                    setPendingId(id);
                    void session
                      .mutatePiPlugins({ ...workspace, action: "update", id })
                      .then((result) => {
                        setPlugins(result.plugins);
                        setConfigs(result.configs ?? []);
                        const state = usePiPluginUpdateStore.getState();
                        state.apply(
                          workspaceKey,
                          result.updates ?? state.updates.filter((item) => item.id !== id),
                          result.updatesCheckedAt ?? state.checkedAt,
                        );
                        toast(intl.formatMessage({ id: "settings.plugins.pi.updated" }));
                      })
                      .catch((error) => {
                        logger.warn("[pi-plugins] update failed", { error });
                        toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
                      })
                      .finally(() => setPendingId(null));
                  }}
                  onRemove={(id) => {
                    setPendingId(id);
                    void session
                      .mutatePiPlugins({ ...workspace, action: "remove", id })
                      .then((result) => {
                        setPlugins(result.plugins);
                        setConfigs(result.configs ?? []);
                        const state = usePiPluginUpdateStore.getState();
                        state.apply(
                          workspaceKey,
                          (result.updates ?? state.updates).filter((item) => item.id !== id),
                          result.updatesCheckedAt ?? state.checkedAt,
                        );
                        toast(intl.formatMessage({ id: "settings.plugins.pi.removed" }));
                      })
                      .catch((error) => {
                        logger.warn("[pi-plugins] remove failed", { error });
                        toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
                      })
                      .finally(() => setPendingId(null));
                  }}
                  onConfigure={(id) => {
                    const plugin = visible.find((item) => item.id === id);
                    const config = plugin ? configFor(plugin, configs) : undefined;
                    if (!config) return;
                    setEditing(config);
                    setDraft(draftOf(config));
                  }}
                  onToggle={(id, enabled) => {
                    setPendingId(id);
                    void session
                      .mutatePiPlugins({
                        ...workspace,
                        action: "setEnabled",
                        id,
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
              )}
            </div>
          }
          workspace={workspace}
          install={(source) =>
            session.mutatePiPlugins({
              ...workspace,
              action: "install",
              source,
              scope,
            })
          }
          onInstalled={(result) => {
            setPlugins(result.plugins);
            setConfigs(result.configs ?? []);
          }}
        />
      ) : (
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.plugins.pi.loading" })}
        </div>
      )}
      <PiPluginConfigDialog
        editing={editing}
        draft={draft}
        saving={saving}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
        onDraft={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
        onSave={() => {
          if (!editing) return;
          setSaving(true);
          void session
            .mutatePiPlugins({
              ...workspace,
              action: "writeConfig",
              id: editing.id,
              values: draft,
            })
            .then((result) => {
              setConfigs(result.configs ?? []);
              setEditing(null);
              toast(intl.formatMessage({ id: "settings.plugins.pi.configSaved" }));
            })
            .catch((error) => {
              logger.warn("[pi-plugins] config save failed", { error });
              toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
            })
            .finally(() => setSaving(false));
        }}
      />
    </div>
  );
}
