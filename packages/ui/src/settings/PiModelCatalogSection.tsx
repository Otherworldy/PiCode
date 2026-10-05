import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, PlugZap, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import type { ZCodePiModelsMutateParams, ZCodePiModelsMutateResult } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import {
  DefaultModelCatalogTab,
  type FlatModelEntry,
} from "@/settings/DefaultModelCatalogTab.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { ProviderSetupDialog } from "@/settings/ProviderSetupDialog.js";
import { emptyProviderDraft, type ProviderDraft } from "@/settings/provider-draft.js";

type CatalogView = ZCodePiModelsMutateResult;
type CatalogProvider = CatalogView["providers"][number];
type ModelSectionTab = "defaultModel" | "providers";

function providerDraft(provider: CatalogProvider): ProviderDraft {
  return {
    existing: true,
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey ?? "",
    models: provider.models.map((model) => ({ ...model })),
  };
}

export function PiModelCatalogSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const [view, setView] = useState<CatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelSectionTab>("defaultModel");
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const workspace = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(await session.mutatePiModels({ ...workspace, action: "get" }));
    } catch (error) {
      logger.warn("[pi-model-catalog] load failed", { error });
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.loadFailed" }));
    } finally {
      setLoading(false);
    }
  }, [intl, session, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (params: ZCodePiModelsMutateParams) => {
      setBusy(true);
      try {
        const next = await session.mutatePiModels({ ...workspace, ...params });
        if (params.action !== "discover") setView(next);
        return next;
      } catch (error) {
        logger.warn("[pi-model-catalog] mutate failed", { error });
        if (params.action !== "discover") {
          toast(intl.formatMessage({ id: "settings.modelProvider.pi.saveFailed" }));
        }
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [intl, session, workspace],
  );

  const testProvider = async (provider: CatalogProvider) => {
    try {
      const next = await mutate({
        action: "discover",
        providerId: provider.id,
        provider: { id: provider.id, baseUrl: provider.baseUrl, api: provider.api, models: [] },
      });
      toast(
        intl.formatMessage(
          { id: "settings.modelProvider.pi.discoverOk" },
          { count: next.discovered?.length ?? 0 },
        ),
      );
    } catch {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.discoverFailed" }));
    }
  };

  const allModels: FlatModelEntry[] = useMemo(
    () =>
      view?.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          providerApi: provider.api,
          model,
        })),
      ) ?? [],
    [view],
  );

  const currentDefault = useMemo(
    () =>
      allModels.find(
        (entry) =>
          entry.providerId === view?.defaultProvider && entry.model.id === view?.defaultModel,
      ) ?? null,
    [allModels, view?.defaultModel, view?.defaultProvider],
  );

  const defaultValue =
    view?.defaultProvider && view.defaultModel ? `${view.defaultProvider}/${view.defaultModel}` : "";

  const handleDefaultModelChange = (value: string) => {
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    const nextProviderId = value.slice(0, slash);
    const nextModelId = value.slice(slash + 1);
    const nextCandidate = allModels.find(
      (entry) => entry.providerId === nextProviderId && entry.model.id === nextModelId,
    );
    const nextThought = nextCandidate?.model.thinkingLevels.includes(view?.defaultThought ?? "")
      ? view?.defaultThought
      : (nextCandidate?.model.thinkingLevels[0] ?? undefined);
    void mutate({
      action: "setDefault",
      defaultProvider: nextProviderId,
      defaultModel: nextModelId,
      ...(nextThought !== undefined ? { defaultThought: nextThought } : {}),
    });
  };

  const handleDefaultThoughtChange = (thought: string) => {
    if (!view?.defaultProvider || !view?.defaultModel) return;
    void mutate({
      action: "setDefault",
      defaultProvider: view.defaultProvider,
      defaultModel: view.defaultModel,
      defaultThought: thought,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between pb-1">
        <SettingsSegmentedTabs
          value={activeTab}
          onValueChange={setActiveTab}
          items={[
            {
              value: "defaultModel",
              label: intl.formatMessage({ id: "settings.modelProvider.pi.tabDefaultModel" }),
            },
            {
              value: "providers",
              label: intl.formatMessage({ id: "settings.modelProvider.pi.tabProviders" }),
            },
          ]}
        />
      </div>

      {activeTab === "defaultModel" ? (
        <DefaultModelCatalogTab
          loading={loading}
          hasView={view !== null}
          allModels={allModels}
          currentDefault={currentDefault}
          defaultValue={defaultValue}
          defaultThought={view?.defaultThought}
          onDefaultModelChange={handleDefaultModelChange}
          onDefaultThoughtChange={handleDefaultThoughtChange}
          onGoToProviders={() => setActiveTab("providers")}
          onAddProvider={() => {
            setActiveTab("providers");
            setEditing(emptyProviderDraft());
          }}
        />
      ) : (
        <section className="space-y-3">
          <SettingsResourceGroupHeader
            count={view?.providers.length ?? 0}
            title={intl.formatMessage({ id: "settings.modelProvider.pi.providers" })}
            actions={
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  <RefreshCw />
                  {intl.formatMessage({ id: "settings.modelProvider.pi.refresh" })}
                </Button>
                <Button type="button" size="sm" onClick={() => setEditing(emptyProviderDraft())}>
                  <Plus />
                  {intl.formatMessage({ id: "settings.modelProvider.add" })}
                </Button>
              </>
            }
          />
          {loading && !view ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.pi.loading" })}
            </p>
          ) : !view || view.providers.length === 0 ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.pi.empty" })}
            </p>
          ) : (
            <SettingsResourceList
              items={view.providers}
              getKey={(provider) => provider.id}
              renderItem={(provider) => {
                const isDefault = view.defaultProvider === provider.id;
                return (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-ui-base font-medium">{provider.name}</span>
                        {isDefault ? (
                          <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                            {intl.formatMessage({ id: "settings.modelProvider.pi.default" })}
                          </span>
                        ) : null}
                        <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-sm text-foreground-subtle ring-1 ring-border">
                          {provider.api}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-ui-sm text-foreground-subtle">
                        {provider.baseUrl || provider.id}
                      </div>
                      <div className="mt-1 truncate text-ui-sm text-foreground-subtle">
                        {provider.models
                          .map((model) =>
                            model.api && model.api !== provider.api
                              ? `${model.id} (${model.api})`
                              : model.id,
                          )
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      {!isDefault && provider.models[0] ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate({
                              action: "setDefault",
                              defaultProvider: provider.id,
                              defaultModel: provider.models[0]!.id,
                            })
                          }
                        >
                          <Star />
                          {intl.formatMessage({ id: "settings.modelProvider.pi.setDefault" })}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(providerDraft(provider))}
                      >
                        <Pencil />
                        {intl.formatMessage({ id: "settings.modelProvider.edit" })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void testProvider(provider)}
                      >
                        <PlugZap />
                        {intl.formatMessage({ id: "settings.modelProvider.pi.testConnection" })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void mutate({ action: "delete", providerId: provider.id })}
                      >
                        <Trash2 />
                        {intl.formatMessage({ id: "settings.modelProvider.delete" })}
                      </Button>
                    </div>
                  </div>
                );
              }}
            />
          )}
        </section>
      )}

      <ProviderSetupDialog
        busy={busy}
        draft={editing}
        existingIds={view?.providers.map((provider) => provider.id) ?? []}
        mutate={mutate}
        onClose={() => setEditing(null)}
        onChange={setEditing}
      />
    </div>
  );
}
