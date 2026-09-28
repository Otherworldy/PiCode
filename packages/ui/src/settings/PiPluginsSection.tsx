import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
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
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type PiPlugin = ZCodePiPluginsResult["plugins"][number];
type PiPluginConfig = NonNullable<ZCodePiPluginsResult["configs"]>[number];
type PiPluginUpdate = NonNullable<ZCodePiPluginsResult["updates"]>[number];
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
  push(plugin.detail.split(/[\\/:@]/u).filter(Boolean).at(-1) ?? "");
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
    return exact.find((config) => config.id.toLowerCase() === plugin.name.toLowerCase()) ?? exact[0];
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
  onVisibleCountChange,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  scope: "user" | "project";
  searchQuery: string;
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
  const [updates, setUpdates] = useState<PiPluginUpdate[]>([]);
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
        setUpdates(found);
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
  }, [intl, scope, session, workspace]);

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-ui-base font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.plugins.pi.title" })}
          </div>
          <div className="mt-1 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.pi.hint" })}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={checking || plugins === null}
          onClick={checkUpdates}
        >
          <RefreshCw />
          {intl.formatMessage({ id: "settings.plugins.checkForUpdates" })}
        </Button>
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
          {visible.map((plugin) => {
            const config = scope === "user" ? configFor(plugin, configs) : undefined;
            return (
              <SettingsRow
                key={plugin.id}
                label={plugin.name}
                description={plugin.detail}
                controlLayout="wide"
                control={
                  <>
                    {updates.some((item) => item.id === plugin.id && item.scope === scope) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pendingId === plugin.id}
                        onClick={() => {
                          setPendingId(plugin.id);
                          void session
                            .mutatePiPlugins({
                              ...workspace,
                              action: "update",
                              id: plugin.id,
                            })
                            .then((result) => {
                              setPlugins(result.plugins);
                              setConfigs(result.configs ?? []);
                              setUpdates((current) =>
                                current.filter((item) => item.id !== plugin.id),
                              );
                              toast(intl.formatMessage({ id: "settings.plugins.pi.updated" }));
                            })
                            .catch((error) => {
                              logger.warn("[pi-plugins] update failed", { error });
                              toast(intl.formatMessage({ id: "settings.plugins.pi.failed" }));
                            })
                            .finally(() => setPendingId(null));
                        }}
                      >
                        <Download />
                        {intl.formatMessage({ id: "settings.plugins.pi.update" })}
                      </Button>
                    ) : null}
                    {config ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(config);
                          setDraft(draftOf(config));
                        }}
                      >
                        {intl.formatMessage({ id: "settings.plugins.pi.configure" })}
                      </Button>
                    ) : null}
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
                  </>
                }
              />
            );
          })}
        </SettingsGroupCard>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
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
                    onCheckedChange={(checked) =>
                      setDraft((current) => ({ ...current, [field.key]: checked }))
                    }
                  />
                ) : (
                  <Input
                    type={
                      field.sensitive ? "password" : field.type === "number" ? "number" : "text"
                    }
                    size="sm"
                    className="h-8"
                    value={String(draft[field.key] ?? "")}
                    disabled={saving}
                    onChange={(event) => {
                      const next =
                        field.type === "number" ? Number(event.target.value) : event.target.value;
                      if (typeof next === "number" && !Number.isFinite(next)) return;
                      setDraft((current) => ({ ...current, [field.key]: next }));
                    }}
                  />
                )}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={saving || !editing}
              onClick={() => {
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
            >
              {intl.formatMessage({ id: "settings.plugins.pi.configSave" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
