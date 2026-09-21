import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodePiModelsMutateParams, ZCodePiModelsMutateResult } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

const API_OPTIONS = [
  { value: "openai-completions", labelId: "settings.modelProvider.apiFormat.chatCompletions" },
  { value: "openai-responses", labelId: "settings.modelProvider.apiFormat.responses" },
  { value: "anthropic-messages", labelId: "settings.modelProvider.apiFormat.anthropicMessages" },
] as const;

type Draft = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  modelsText: string;
};

const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  modelsText: "",
});

function parseModelsText(text: string): Array<{ id: string; name?: string }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [rawId, ...rest] = line.split("|");
      const id = rawId?.trim() ?? "";
      if (!id) return [];
      const name = rest.join("|").trim();
      return [{ id, ...(name ? { name } : {}) }];
    });
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
  const [view, setView] = useState<ZCodePiModelsMutateResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
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
        toast(intl.formatMessage({ id: "settings.modelProvider.pi.saveFailed" }));
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [intl, session, workspace],
  );

  const openCreate = () => {
    setEditingExisting(false);
    setEditing(emptyDraft());
  };

  const openEdit = (provider: ZCodePiModelsMutateResult["providers"][number]) => {
    setEditingExisting(true);
    setEditing({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: "",
      modelsText: provider.models
        .map((model) => (model.name && model.name !== model.id ? `${model.id}|${model.name}` : model.id))
        .join("\n"),
    });
  };

  const saveDraft = async () => {
    if (!editing) return;
    const models = parseModelsText(editing.modelsText);
    if (!editing.id.trim() || !editing.baseUrl.trim() || models.length === 0) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.invalid" }));
      return;
    }
    await mutate({
      action: "upsert",
      provider: {
        id: editing.id.trim(),
        name: editing.name.trim() || editing.id.trim(),
        baseUrl: editing.baseUrl.trim(),
        api: editing.api,
        ...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
        models,
      },
    });
    setEditing(null);
  };

  const fetchModels = async () => {
    if (!editing?.baseUrl.trim()) return;
    const next = await mutate({
      action: "discover",
      providerId: editing.id.trim() || undefined,
      provider: {
        id: editing.id.trim() || "tmp",
        baseUrl: editing.baseUrl.trim(),
        api: editing.api,
        ...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
        models: [],
      },
    });
    if (next.discovered?.length) {
      setEditing((current) =>
        current
          ? {
              ...current,
              modelsText: next.discovered!.map((model) => model.id).join("\n"),
            }
          : current,
      );
    }
  };

  const defaultValue =
    view?.defaultProvider && view.defaultModel
      ? `${view.defaultProvider}/${view.defaultModel}`
      : "";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.source" })}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {intl.formatMessage({ id: "settings.modelProvider.pi.refresh" })}
        </Button>
      </div>

      {view && view.providers.length > 0 ? (
        <div className="space-y-2">
          <Label>{intl.formatMessage({ id: "settings.modelProvider.pi.defaultModel" })}</Label>
          <Select
            value={defaultValue}
            onValueChange={(value) => {
              const slash = value.indexOf("/");
              if (slash <= 0) return;
              void mutate({
                action: "setDefault",
                defaultProvider: value.slice(0, slash),
                defaultModel: value.slice(slash + 1),
              });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {view.providers.flatMap((provider) =>
                provider.models.map((model) => (
                  <SelectItem key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>
                    {provider.name}/{model.id}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={openCreate}>
          {intl.formatMessage({ id: "settings.modelProvider.add" })}
        </Button>
      </div>

      {loading && !view ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.loading" })}
        </p>
      ) : !view || view.providers.length === 0 ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.pi.empty" })}
        </p>
      ) : (
        view.providers.map((provider) => {
          const isDefault = view.defaultProvider === provider.id;
          return (
            <SettingsGroupCard key={provider.id}>
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <h3 className="text-ui-md font-medium text-foreground">{provider.name}</h3>
                  <p className="truncate text-ui-sm text-foreground-subtle">
                    {provider.baseUrl || provider.id}
                    {isDefault
                      ? ` · ${intl.formatMessage({ id: "settings.modelProvider.pi.default" })}`
                      : ""}
                    {` · ${intl.formatMessage(
                      { id: "settings.modelProvider.modelsCount" },
                      { count: provider.models.length },
                    )}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => openEdit(provider)}>
                    {intl.formatMessage({ id: "settings.modelProvider.edit" })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate({ action: "delete", providerId: provider.id })}
                  >
                    {intl.formatMessage({ id: "settings.modelProvider.delete" })}
                  </Button>
                </div>
              </div>
              {provider.models.map((model) => (
                <div
                  key={`${provider.id}/${model.id}`}
                  className="border-t border-border px-4 py-2 text-ui-base text-foreground"
                >
                  {model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id}
                </div>
              ))}
            </SettingsGroupCard>
          );
        })
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({
                id: editingExisting ? "settings.modelProvider.edit" : "settings.modelProvider.add",
              })}
            </DialogTitle>
          </DialogHeader>
          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.pi.providerId" })}</Label>
                <Input
                  value={editing.id}
                  disabled={editingExisting}
                  onChange={(event) => setEditing({ ...editing, id: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.name" })}</Label>
                <Input
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}</Label>
                <Input
                  value={editing.baseUrl}
                  placeholder={intl.formatMessage({ id: "settings.modelProvider.baseUrlPlaceholder" })}
                  onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}</Label>
                <Select
                  value={editing.api}
                  onValueChange={(value) => setEditing({ ...editing, api: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {API_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {intl.formatMessage({ id: option.labelId })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.apiKey" })}</Label>
                <Input
                  type="password"
                  value={editing.apiKey}
                  placeholder={intl.formatMessage({
                    id: editingExisting
                      ? "settings.modelProvider.pi.apiKeyKeep"
                      : "settings.modelProvider.apiKeyPlaceholder",
                  })}
                  onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label>{intl.formatMessage({ id: "settings.modelProvider.models" })}</Label>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void fetchModels()}>
                    {intl.formatMessage({ id: "settings.modelProvider.pi.fetchModels" })}
                  </Button>
                </div>
                <Textarea
                  rows={8}
                  value={editing.modelsText}
                  placeholder={intl.formatMessage({ id: "settings.modelProvider.modelsPlaceholder" })}
                  onChange={(event) => setEditing({ ...editing, modelsText: event.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void saveDraft()}>
              {intl.formatMessage({ id: "settings.modelProvider.save" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
