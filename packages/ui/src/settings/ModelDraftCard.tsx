import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Download, Plus, Trash2 } from "lucide-react";
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
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import {
  API_OPTIONS,
  CONTEXT_PRESETS,
  OUTPUT_PRESETS,
  THINKING_LEVELS,
  applyModelPatch,
  defaultChosen,
  type CatalogModel,
  type ModelPatch,
  type ProviderDraft,
} from "@/settings/provider-draft.js";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`.replace(/\.0M$/u, "M");
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`.replace(/\.0K$/u, "K");
  return String(value);
}

export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function ApiSelect({
  value,
  inheritLabel,
  onChange,
}: {
  value: string;
  inheritLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel ? <SelectItem value="inherit">{inheritLabel}</SelectItem> : null}
        {API_OPTIONS.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ModelDraftList({
  busy,
  draft,
  onChange,
  onFetch,
}: {
  busy: boolean;
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  onFetch: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [expandedId, setExpandedId] = useState<string | null>(draft.models[0]?.id ?? null);
  const [customId, setCustomId] = useState("");
  const patchModel = (modelId: string, partial: ModelPatch) => {
    onChange({
      ...draft,
      models: draft.models.map((model) =>
        model.id === modelId ? applyModelPatch(model, partial) : model,
      ),
    });
  };
  const addCustom = () => {
    const id = customId.trim();
    if (!id) return;
    if (draft.models.some((model) => model.id === id)) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.modelExists" }));
      return;
    }
    onChange({ ...draft, models: [...draft.models, defaultChosen({ id, name: id })] });
    setExpandedId(id);
    setCustomId("");
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-sm font-medium">
          {intl.formatMessage({ id: "settings.modelProvider.pi.modelList" })}
        </span>
        <Input
          className="ml-auto h-7 max-w-52 font-mono"
          placeholder={intl.formatMessage({ id: "settings.modelProvider.pi.modelId" })}
          value={customId}
          onChange={(event) => setCustomId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addCustom();
            }
          }}
        />
        <Button type="button" size="sm" onClick={addCustom}>
          <Plus className="size-3.5" />
          {intl.formatMessage({ id: "settings.modelProvider.pi.addModel" })}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onFetch}>
          <Download />
          {intl.formatMessage({ id: "settings.modelProvider.pi.fetch" })}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
          {draft.models.length === 0 ? (
            <p className="py-8 text-center text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.pi.needModels" })}
            </p>
          ) : (
            draft.models.map((model) => (
              <ModelCard
                key={model.id}
                expanded={expandedId === model.id}
                inheritApi={draft.api}
                model={model}
                onPatch={(partial) => patchModel(model.id, partial)}
                onRemove={() => {
                  const models = draft.models.filter((item) => item.id !== model.id);
                  onChange({ ...draft, models });
                  if (expandedId === model.id) setExpandedId(models[0]?.id ?? null);
                }}
                onToggle={() => setExpandedId(expandedId === model.id ? null : model.id)}
              />
            ))
          )}
        </div>
    </div>
  );
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

function ModelCard({
  expanded,
  inheritApi,
  model,
  onPatch,
  onRemove,
  onToggle,
}: {
  expanded: boolean;
  inheritApi: string;
  model: CatalogModel;
  onPatch: (partial: ModelPatch) => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const { intl } = useZCodeIntl();
  const override = model.api && model.api !== inheritApi ? model.api : "";
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card", expanded && "border-primary")}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
          onClick={onToggle}
        >
          <span className="truncate font-mono text-ui-sm font-medium">{model.id}</span>
          {model.name && model.name !== model.id ? (
            <span className="truncate text-ui-xs text-foreground-subtle">{model.name}</span>
          ) : null}
          <span className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {override || intl.formatMessage({ id: "settings.modelProvider.pi.apiInherit" })}
          </span>
          <span className="font-mono text-ui-xs text-foreground-subtle">
            {formatTokens(model.contextWindow)} · {formatTokens(model.maxTokens)}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({
            id: expanded ? "settings.modelProvider.pi.collapse" : "settings.modelProvider.pi.expand",
          })}
          title={intl.formatMessage({
            id: expanded ? "settings.modelProvider.pi.collapse" : "settings.modelProvider.pi.expand",
          })}
          onClick={onToggle}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "settings.modelProvider.delete" })}
          title={intl.formatMessage({ id: "settings.modelProvider.delete" })}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      {expanded ? (
        <div className="grid gap-3 border-t border-border bg-surface/40 px-3 py-3 sm:grid-cols-2">
          <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.modelId" })}>
            <Input className="font-mono" disabled value={model.id} />
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.alias" })}>
            <Input
              value={model.name === model.id ? "" : model.name}
              onChange={(event) => onPatch({ name: event.target.value.trim() || model.id })}
            />
          </Field>
          <Field className="sm:col-span-2" label={intl.formatMessage({ id: "settings.modelProvider.pi.modelApi" })}>
            <ApiSelect
              inheritLabel={intl.formatMessage({ id: "settings.modelProvider.pi.apiInherit" })}
              value={override || "inherit"}
              onChange={(value) => onPatch({ api: value === "inherit" ? null : value })}
            />
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.contextWindow" })}>
            <Input
              className="font-mono"
              type="number"
              value={model.contextWindow}
              onChange={(event) =>
                onPatch({ contextWindow: Number(event.target.value) || model.contextWindow })
              }
            />
            <PresetChips
              presets={CONTEXT_PRESETS}
              value={model.contextWindow}
              onChange={(value) => onPatch({ contextWindow: value })}
            />
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.maxOutputTokens" })}>
            <Input
              className="font-mono"
              type="number"
              value={model.maxTokens}
              onChange={(event) => onPatch({ maxTokens: Number(event.target.value) || model.maxTokens })}
            />
            <PresetChips
              presets={OUTPUT_PRESETS}
              value={model.maxTokens}
              onChange={(value) => onPatch({ maxTokens: value })}
            />
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.inputType" })}>
            <div className="flex h-7 items-center gap-3 text-ui-sm">
              <label className="flex items-center gap-1.5">
                <Checkbox checked disabled />
                {intl.formatMessage({ id: "settings.modelProvider.pi.text" })}
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={model.input.includes("image")}
                  onCheckedChange={(checked) =>
                    onPatch({ input: checked === true ? ["text", "image"] : ["text"] })
                  }
                />
                {intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}
              </label>
            </div>
          </Field>
          <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.thinkingLevels" })}>
            <div className="flex flex-wrap items-center gap-2 text-ui-xs">
              {THINKING_LEVELS.map((level) => {
                const selected = model.thinkingLevels.includes(level);
                return (
                  <label key={level} className="flex items-center gap-1">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => {
                        const thinkingLevels = selected
                          ? model.thinkingLevels.filter((item) => item !== level)
                          : [...model.thinkingLevels, level];
                        onPatch({ thinkingLevels });
                      }}
                    />
                    {level}
                  </label>
                );
              })}
            </div>
          </Field>
        </div>
      ) : null}
    </div>
  );
}
