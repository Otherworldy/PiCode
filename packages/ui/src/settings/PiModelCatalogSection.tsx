/* eslint-disable max-lines -- 模型设置页与供应商双面板编辑共用一份草稿状态，拆开会双写勾选/展开。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, RefreshCw, Search, X } from "lucide-react";
import type { ZCodePiModelsMutateParams, ZCodePiModelsMutateResult } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";

const API_OPTIONS = [
  { value: "openai-completions", labelId: "settings.modelProvider.apiFormat.chatCompletions" },
  { value: "openai-responses", labelId: "settings.modelProvider.apiFormat.responses" },
  { value: "anthropic-messages", labelId: "settings.modelProvider.apiFormat.anthropicMessages" },
  { value: "google-generative-ai", labelId: "settings.modelProvider.apiFormat.googleGenerativeAi" },
] as const;

const SERVICE_PRESETS = [
  { value: "custom" },
  {
    value: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
  },
  {
    value: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  },
  {
    value: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
  },
] as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CONTEXT_PRESETS = [
  { label: "128k", value: 128_000 },
  { label: "256k", value: 256_000 },
  { label: "312k", value: 312_000 },
  { label: "500k", value: 500_000 },
  { label: "1M", value: 1_048_576 },
] as const;
const OUTPUT_PRESETS = [
  { label: "4k", value: 4096 },
  { label: "8k", value: 8192 },
  { label: "16k", value: 16_384 },
  { label: "32k", value: 32_768 },
  { label: "128k", value: 128_000 },
] as const;

type CatalogView = ZCodePiModelsMutateResult;
type CatalogModel = CatalogView["providers"][number]["models"][number];
type OfferedModel = { id: string; name: string; contextWindow?: number; maxTokens?: number };

type ProviderDraft = {
  existing: boolean;
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: CatalogModel[];
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const million = value / 1_000_000;
    const text =
      million >= 10
        ? million.toFixed(0)
        : million.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
    return `${text}M`;
  }
  if (value >= 1000) {
    const thousand = value / 1000;
    return `${Number.isInteger(thousand) ? String(thousand) : thousand.toFixed(1).replace(/\.0$/u, "")}K`;
  }
  return String(value);
}

function limitsLabel(contextWindow?: number, maxTokens?: number): string {
  if (!contextWindow && !maxTokens) return "";
  return `${contextWindow ? formatTokens(contextWindow) : "—"} · ${maxTokens ? formatTokens(maxTokens) : "—"}`;
}

function slugProviderId(name: string, url: string): string {
  const fromName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (fromName) return fromName;
  try {
    const host = new URL(url).hostname.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    if (host) return host;
  } catch {
    // 名称非拉丁且 URL 非法时走时间戳 id。
  }
  return `custom-${Date.now().toString(36)}`;
}

function emptyDraft(): ProviderDraft {
  return {
    existing: false,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    models: [],
  };
}

function defaultChosen(offered: OfferedModel): CatalogModel {
  return {
    id: offered.id,
    name: offered.name && offered.name !== offered.id ? offered.name : offered.id,
    contextWindow: offered.contextWindow ?? 128_000,
    maxTokens: offered.maxTokens ?? 8192,
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    defaultThinkingLevel: "high",
    input: ["text"],
  };
}

function mergeOffered(discovered: OfferedModel[], chosen: CatalogModel[]): OfferedModel[] {
  const byId = new Map<string, OfferedModel>();
  for (const item of discovered) byId.set(item.id, item);
  for (const model of chosen) {
    if (!byId.has(model.id)) {
      byId.set(model.id, {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      });
    }
  }
  return [...byId.values()];
}

function PresetChips({
  presets,
  value,
  onChange,
}: {
  presets: ReadonlyArray<{ label: string; value: number }>;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {presets.map((preset) => (
        <button
          key={preset.value}
          type="button"
          className={cn(
            "rounded-sm px-1.5 py-0.5 font-mono text-ui-xs",
            value === preset.value
              ? "bg-foreground text-background"
              : "bg-surface text-foreground-subtle hover:bg-surface-hover",
          )}
          onClick={() => onChange(preset.value)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
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
        toast(intl.formatMessage({ id: "settings.modelProvider.pi.saveFailed" }));
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [intl, session, workspace],
  );

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
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "settings.modelProvider.pi.refresh" })}
          </Button>
          <Button type="button" size="sm" onClick={() => setEditing(emptyDraft())}>
            <Plus className="size-3.5" />
            {intl.formatMessage({ id: "settings.modelProvider.add" })}
          </Button>
        </div>
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
                  <SelectItem
                    key={`${provider.id}/${model.id}`}
                    value={`${provider.id}/${model.id}`}
                  >
                    {provider.name}/
                    {model.name !== model.id ? `${model.id} (${model.name})` : model.id}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
        </div>
      ) : null}

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
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-ui-base font-medium text-foreground">{provider.name}</h3>
                    {isDefault ? (
                      <span className="rounded-sm bg-success/15 px-1.5 py-0.5 text-ui-xs font-medium text-success">
                        {intl.formatMessage({ id: "settings.modelProvider.pi.default" })}
                      </span>
                    ) : null}
                    <span className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
                      {provider.api}
                    </span>
                  </div>
                  <p className="truncate font-mono text-ui-sm text-foreground-subtle">
                    {provider.baseUrl || provider.id}
                  </p>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {provider.models.slice(0, 4).map((model) => (
                      <span
                        key={model.id}
                        className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
                      >
                        {model.id}
                      </span>
                    ))}
                    {provider.models.length > 4 ? (
                      <button
                        type="button"
                        className="text-ui-xs text-foreground-subtle hover:text-foreground"
                        onClick={() =>
                          setEditing({
                            existing: true,
                            id: provider.id,
                            name: provider.name,
                            baseUrl: provider.baseUrl,
                            api: provider.api,
                            apiKey: "",
                            models: provider.models.map((model) => ({ ...model })),
                          })
                        }
                      >
                        +{provider.models.length - 4}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!isDefault && provider.models[0] ? (
                    <Button
                      type="button"
                      variant="ghost"
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
                      {intl.formatMessage({ id: "settings.modelProvider.pi.setDefault" })}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        existing: true,
                        id: provider.id,
                        name: provider.name,
                        baseUrl: provider.baseUrl,
                        api: provider.api,
                        apiKey: "",
                        models: provider.models.map((model) => ({ ...model })),
                      })
                    }
                  >
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
            </SettingsGroupCard>
          );
        })
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

function ProviderSetupDialog({
  busy,
  draft,
  existingIds,
  mutate,
  onClose,
  onChange,
}: {
  busy: boolean;
  draft: ProviderDraft | null;
  existingIds: string[];
  mutate: (params: ZCodePiModelsMutateParams) => Promise<CatalogView>;
  onClose: () => void;
  onChange: (draft: ProviderDraft | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [discovered, setDiscovered] = useState<OfferedModel[]>([]);
  const [leftQuery, setLeftQuery] = useState("");
  const [rightQuery, setRightQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customId, setCustomId] = useState("");
  const [preset, setPreset] = useState("custom");

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dialogOpen = Boolean(draft);
  const dialogSeed = draft ? `${draft.existing ? "e" : "n"}:${draft.id}` : "";
  useEffect(() => {
    const current = draftRef.current;
    if (!current) {
      setDiscovered([]);
      setLeftQuery("");
      setRightQuery("");
      setExpandedId(null);
      setCustomId("");
      setPreset("custom");
      return;
    }
    setDiscovered(
      current.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    );
    setExpandedId(current.models[0]?.id ?? null);
  }, [dialogOpen, dialogSeed]);

  const offered = useMemo(
    () => mergeOffered(discovered, draft?.models ?? []),
    [discovered, draft?.models],
  );
  const chosenIds = useMemo(
    () => new Set(draft?.models.map((model) => model.id) ?? []),
    [draft?.models],
  );
  const visibleOffered = offered.filter((item) => {
    const query = leftQuery.trim().toLowerCase();
    return !query || `${item.id} ${item.name}`.toLowerCase().includes(query);
  });
  const visibleChosen = (draft?.models ?? []).filter((model) => {
    const query = rightQuery.trim().toLowerCase();
    return !query || `${model.id} ${model.name}`.toLowerCase().includes(query);
  });
  const checkedVisible = visibleOffered.filter((item) => chosenIds.has(item.id)).length;
  const selectAllState =
    visibleOffered.length === 0
      ? false
      : checkedVisible === visibleOffered.length
        ? true
        : checkedVisible > 0
          ? "indeterminate"
          : false;

  const patch = (partial: Partial<ProviderDraft>) => {
    if (!draft) return;
    onChange({ ...draft, ...partial });
  };

  const patchModel = (modelId: string, partial: Partial<CatalogModel>) => {
    if (!draft) return;
    onChange({
      ...draft,
      models: draft.models.map((model) =>
        model.id === modelId ? { ...model, ...partial } : model,
      ),
    });
  };

  const toggleModel = (offeredItem: OfferedModel, checked: boolean) => {
    if (!draft) return;
    if (checked) {
      if (draft.models.some((model) => model.id === offeredItem.id)) return;
      onChange({ ...draft, models: [...draft.models, defaultChosen(offeredItem)] });
      setExpandedId(offeredItem.id);
      return;
    }
    const next = draft.models.filter((model) => model.id !== offeredItem.id);
    onChange({ ...draft, models: next });
    if (expandedId === offeredItem.id) setExpandedId(next[0]?.id ?? null);
  };

  const fetchModels = async (announce: boolean) => {
    if (!draft?.baseUrl.trim()) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    try {
      const next = await mutate({
        action: "discover",
        providerId: draft.id.trim() || undefined,
        provider: {
          id: draft.id.trim() || "tmp",
          baseUrl: draft.baseUrl.trim(),
          api: draft.api,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          models: [],
        },
      });
      const list = next.discovered ?? [];
      setDiscovered(list);
      if (announce) {
        toast(
          intl.formatMessage(
            { id: "settings.modelProvider.pi.discoverOk" },
            { count: list.length },
          ),
        );
      }
    } catch {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.discoverFailed" }));
    }
  };

  const addCustom = () => {
    if (!draft) return;
    const id = customId.trim();
    if (!id) return;
    if (draft.models.some((model) => model.id === id)) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.modelExists" }));
      return;
    }
    const added = defaultChosen({ id, name: id });
    onChange({ ...draft, models: [...draft.models, added] });
    setExpandedId(id);
    setCustomId("");
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!name || !baseUrl) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    if (draft.models.length === 0) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needModels" }));
      return;
    }
    const id = draft.existing ? draft.id : slugProviderId(name, baseUrl);
    if (!draft.existing && existingIds.includes(id)) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.duplicateId" }));
      return;
    }
    await mutate({
      action: "upsert",
      provider: {
        id,
        name,
        baseUrl,
        api: draft.api,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        models: draft.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.thinkingLevels.some((level) => level !== "off"),
          thinkingLevels: model.thinkingLevels,
          ...(model.defaultThinkingLevel
            ? { defaultThinkingLevel: model.defaultThinkingLevel }
            : {}),
          input: model.input,
        })),
      },
    });
    onClose();
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(48rem,calc(100vh-3rem))] max-w-[min(66rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-5 py-4">
          <DialogTitle className="text-ui-lg">
            {intl.formatMessage({
              id: draft?.existing
                ? "settings.modelProvider.pi.editService"
                : "settings.modelProvider.pi.addService",
            })}
          </DialogTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void fetchModels(true)}
            >
              {intl.formatMessage({ id: "settings.modelProvider.pi.testConnection" })}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              {intl.formatMessage({ id: "settings.modelProvider.pi.saveService" })}
            </Button>
          </div>
        </DialogHeader>

        {draft ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4">
            <div className="grid shrink-0 gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.pi.service" })}</Label>
                <Select
                  value={preset}
                  onValueChange={(value) => {
                    setPreset(value);
                    const selected = SERVICE_PRESETS.find((item) => item.value === value);
                    if (!selected || selected.value === "custom") return;
                    patch({ name: selected.name, baseUrl: selected.baseUrl, api: selected.api });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_PRESETS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.value === "custom"
                          ? intl.formatMessage({ id: "settings.modelProvider.pi.serviceCustom" })
                          : item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.name" })}</Label>
                <Input
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.pi.endpoint" })}</Label>
                <Input
                  value={draft.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.apiKey" })}</Label>
                <Input
                  type="password"
                  value={draft.apiKey}
                  placeholder="sk-..."
                  onChange={(event) => patch({ apiKey: event.target.value })}
                />
                <p className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.apiKeyKeep" })}
                </p>
              </div>
              <div className="space-y-1">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}</Label>
                <Select value={draft.api} onValueChange={(value) => patch({ api: value })}>
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
            </div>

            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background-alt">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <Checkbox
                    checked={selectAllState}
                    onCheckedChange={(checked) => {
                      if (checked === true) {
                        const next = [...draft.models];
                        for (const item of visibleOffered) {
                          if (!next.some((model) => model.id === item.id))
                            next.push(defaultChosen(item));
                        }
                        patch({ models: next });
                        return;
                      }
                      const visibleIds = new Set(visibleOffered.map((item) => item.id));
                      patch({ models: draft.models.filter((model) => !visibleIds.has(model.id)) });
                    }}
                  />
                  <span className="text-ui-xs font-medium tracking-wide text-foreground-subtle uppercase">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.offeredModels" })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void fetchModels(true)}
                  >
                    <RefreshCw className="size-3" />
                    {intl.formatMessage({ id: "settings.modelProvider.pi.fetchList" })}
                  </Button>
                  <div className="ml-auto flex min-w-0 items-center gap-1 rounded-md border border-border bg-input px-2">
                    <Search className="size-3 text-foreground-subtle" />
                    <Input
                      value={leftQuery}
                      className="h-6 border-0 bg-transparent px-0 shadow-none"
                      placeholder={intl.formatMessage({
                        id: "settings.modelProvider.pi.searchOffered",
                      })}
                      onChange={(event) => setLeftQuery(event.target.value)}
                    />
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="py-1">
                    {visibleOffered.map((item) => (
                      <li key={item.id}>
                        <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-surface-hover">
                          <Checkbox
                            checked={chosenIds.has(item.id)}
                            onCheckedChange={(checked) => toggleModel(item, checked === true)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-ui-sm font-medium text-foreground">
                            {item.id}
                          </span>
                          {item.name && item.name !== item.id ? (
                            <span className="hidden truncate text-ui-xs text-foreground-subtle sm:inline">
                              {item.name}
                            </span>
                          ) : null}
                          <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                            {limitsLabel(item.contextWindow, item.maxTokens)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background-alt">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <span className="text-ui-xs font-medium tracking-wide text-foreground-subtle uppercase">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.modelSettings" })}
                  </span>
                  <span className="rounded-full bg-surface px-1.5 text-ui-xs text-foreground-subtle">
                    {draft.models.length}
                  </span>
                  <div className="ml-auto flex min-w-0 items-center gap-1 rounded-md border border-border bg-input px-2">
                    <Search className="size-3 text-foreground-subtle" />
                    <Input
                      value={rightQuery}
                      className="h-6 border-0 bg-transparent px-0 shadow-none"
                      placeholder={intl.formatMessage({
                        id: "settings.modelProvider.pi.searchChosen",
                      })}
                      onChange={(event) => setRightQuery(event.target.value)}
                    />
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="flex flex-col gap-2 p-2">
                    {visibleChosen.length === 0 ? (
                      <p className="px-2 py-8 text-center text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.modelProvider.pi.noChosen" })}
                      </p>
                    ) : (
                      visibleChosen.map((model) => {
                        const expanded = expandedId === model.id;
                        return (
                          <div
                            key={model.id}
                            className={cn(
                              "overflow-hidden rounded-md border border-border bg-card",
                              expanded && "border-border-hover",
                            )}
                          >
                            <div className="flex items-center gap-2 px-3 py-2">
                              <GripVertical className="size-3.5 text-foreground-subtlest" />
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                onClick={() => setExpandedId(expanded ? null : model.id)}
                              >
                                <span className="truncate font-mono text-ui-sm font-medium">
                                  {model.id}
                                </span>
                                {model.name && model.name !== model.id ? (
                                  <span className="truncate text-ui-xs text-foreground-subtle">
                                    ({model.name})
                                  </span>
                                ) : null}
                                <span className="font-mono text-ui-xs text-foreground-subtle">
                                  {limitsLabel(model.contextWindow, model.maxTokens)}
                                </span>
                              </button>
                              <button
                                type="button"
                                className={cn(
                                  "rounded-sm px-1.5 py-0.5 text-ui-xs",
                                  expanded
                                    ? "bg-accent text-foreground"
                                    : "bg-surface text-foreground-subtle",
                                )}
                                onClick={() => setExpandedId(expanded ? null : model.id)}
                              >
                                {intl.formatMessage({
                                  id: expanded
                                    ? "settings.modelProvider.pi.collapse"
                                    : "settings.modelProvider.advanced",
                                })}
                              </button>
                              <button
                                type="button"
                                className="rounded-sm p-1 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => toggleModel(model, false)}
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                            {expanded ? (
                              <div className="space-y-3 border-t border-border bg-surface/40 px-3 py-3">
                                <div className="space-y-1">
                                  <Label>
                                    {intl.formatMessage({ id: "settings.modelProvider.pi.alias" })}
                                  </Label>
                                  <Input
                                    value={model.name === model.id ? "" : model.name}
                                    placeholder={intl.formatMessage({
                                      id: "settings.modelProvider.pi.aliasPlaceholder",
                                    })}
                                    onChange={(event) =>
                                      patchModel(model.id, {
                                        name: event.target.value.trim() || model.id,
                                      })
                                    }
                                  />
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div className="space-y-1">
                                    <Label>
                                      {intl.formatMessage({
                                        id: "settings.modelProvider.contextWindow",
                                      })}
                                    </Label>
                                    <PresetChips
                                      presets={CONTEXT_PRESETS}
                                      value={model.contextWindow}
                                      onChange={(value) =>
                                        patchModel(model.id, { contextWindow: value })
                                      }
                                    />
                                    <Input
                                      type="number"
                                      value={model.contextWindow}
                                      onChange={(event) =>
                                        patchModel(model.id, {
                                          contextWindow:
                                            Number(event.target.value) || model.contextWindow,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label>
                                      {intl.formatMessage({
                                        id: "settings.modelProvider.maxOutputTokens",
                                      })}
                                    </Label>
                                    <PresetChips
                                      presets={OUTPUT_PRESETS}
                                      value={model.maxTokens}
                                      onChange={(value) =>
                                        patchModel(model.id, { maxTokens: value })
                                      }
                                    />
                                    <Input
                                      type="number"
                                      value={model.maxTokens}
                                      onChange={(event) =>
                                        patchModel(model.id, {
                                          maxTokens: Number(event.target.value) || model.maxTokens,
                                        })
                                      }
                                    />
                                  </div>
                                </div>
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <Label>
                                      {intl.formatMessage({
                                        id: "settings.modelProvider.pi.thinkingLevels",
                                      })}
                                    </Label>
                                    <div className="flex items-center gap-2">
                                      <span className="text-ui-xs text-foreground-subtle">
                                        {intl.formatMessage({
                                          id: "settings.modelProvider.pi.defaultThinking",
                                        })}
                                      </span>
                                      <Select
                                        value={
                                          model.defaultThinkingLevel ??
                                          model.thinkingLevels[0] ??
                                          "off"
                                        }
                                        onValueChange={(value) =>
                                          patchModel(model.id, { defaultThinkingLevel: value })
                                        }
                                      >
                                        <SelectTrigger size="sm" className="w-24">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {THINKING_LEVELS.filter(
                                            (level) =>
                                              level === "off" ||
                                              level === "low" ||
                                              level === "medium" ||
                                              level === "high" ||
                                              level === "max",
                                          ).map((level) => (
                                            <SelectItem key={level} value={level}>
                                              {level}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {THINKING_LEVELS.map((level) => {
                                      const selected = model.thinkingLevels.includes(level);
                                      return (
                                        <button
                                          key={level}
                                          type="button"
                                          className={cn(
                                            "rounded-full px-2.5 py-0.5 text-ui-xs",
                                            selected
                                              ? "bg-foreground text-background"
                                              : "bg-surface text-foreground-subtle hover:bg-surface-hover",
                                          )}
                                          onClick={() => {
                                            const thinkingLevels = selected
                                              ? model.thinkingLevels.filter(
                                                  (item) => item !== level,
                                                )
                                              : [...model.thinkingLevels, level];
                                            patchModel(model.id, { thinkingLevels });
                                          }}
                                        >
                                          {level}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                                <label className="flex items-center gap-2 text-ui-sm text-foreground">
                                  <Checkbox
                                    checked={model.input.includes("image")}
                                    onCheckedChange={(checked) =>
                                      patchModel(model.id, {
                                        input: checked === true ? ["text", "image"] : ["text"],
                                      })
                                    }
                                  />
                                  {intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}
                                </label>
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </ScrollArea>
                <div className="space-y-1.5 border-t border-border bg-card px-3 py-2">
                  <span className="text-ui-xs font-medium text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.custom" })}
                  </span>
                  <div className="flex gap-2">
                    <Input
                      value={customId}
                      placeholder={intl.formatMessage({
                        id: "settings.modelProvider.pi.customPlaceholder",
                      })}
                      onChange={(event) => setCustomId(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCustom();
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addCustom}>
                      <Plus className="size-3.5" />
                      {intl.formatMessage({ id: "settings.modelProvider.pi.addCustom" })}
                    </Button>
                  </div>
                  <p className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.customHint" })}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
