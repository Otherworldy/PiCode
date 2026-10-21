/* oxlint-disable eslint(max-lines) -- 模型草稿列表集中处理过滤筛选、快录添加以及单模型规格与模态展开配置。 */
import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  Lightbulb,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
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
      <SelectTrigger size="lg" className="w-full font-mono">
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
  const [searchQuery, setSearchQuery] = useState("");

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

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return draft.models;
    return draft.models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)),
    );
  }, [draft.models, searchQuery]);

  return (
    <div className="space-y-3">
      {/* 列表标题与右侧紧凑操作工具条 */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.pi.modelList" })}
          </span>
          <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {draft.models.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* 实时筛选过滤 */}
          {draft.models.length > 3 ? (
            <div className="relative w-36">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
              <Input
                size="lg"
                className="h-8 pl-8 pr-2 text-ui-sm"
                placeholder={intl.formatMessage({ id: "settings.modelProvider.pi.searchChosen" })}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
          ) : null}

          {/* 快速添加模型输入框 + 按钮组合 */}
          <div className="flex items-center">
            <Input
              size="lg"
              className="h-8 w-40 rounded-r-none border-r-0 font-mono text-ui-sm"
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
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-8 rounded-l-none px-3"
              onClick={addCustom}
              title={intl.formatMessage({ id: "settings.modelProvider.pi.addModel" })}
            >
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">
                {intl.formatMessage({ id: "settings.modelProvider.pi.addModel" })}
              </span>
            </Button>
          </div>

          {/* 从端点同步拉取模型 */}
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-8 shrink-0 gap-1.5 px-3"
            disabled={busy}
            onClick={onFetch}
          >
            <Download className="size-3.5" />
            <span>{intl.formatMessage({ id: "settings.modelProvider.pi.fetch" })}</span>
          </Button>
        </div>
      </div>

      {/* 统一外框容器与细分隔线，取代堆叠独立卡片 */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {draft.models.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-ui-base text-foreground-subtle">
            <p>{intl.formatMessage({ id: "settings.modelProvider.pi.needModels" })}</p>
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="p-6 text-center text-ui-sm text-foreground-subtle">未找到匹配的模型</div>
        ) : (
          <div className="divide-y divide-border">
            {filteredModels.map((model) => (
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
            ))}
          </div>
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
            "rounded border px-1.5 py-0.5 font-mono text-ui-xs transition-colors",
            value === preset.value
              ? "border-primary bg-primary text-primary-foreground font-semibold"
              : "border-border bg-surface text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
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
  const hasVision = model.input.includes("image");
  const hasReasoning = model.thinkingLevels.some((lvl) => lvl !== "off");

  return (
    <div className="transition-colors hover:bg-surface/30">
      {/* 摘要标题栏：ID 突出（大、semibold），别名小而轻，右侧紧凑胶囊与操作 */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
          onClick={onToggle}
        >
          {/* 模型 ID 字体大、主视觉 */}
          <span className="truncate font-mono text-ui-base font-semibold text-foreground">
            {model.id}
          </span>

          {/* 别名字体小、辅助视觉 */}
          {model.name && model.name !== model.id ? (
            <span className="truncate text-ui-xs text-foreground-subtle">{model.name}</span>
          ) : null}

          {/* 协议徽章 */}
          <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {override || intl.formatMessage({ id: "settings.modelProvider.pi.apiInherit" })}
          </span>

          {/* 模态特性指示小徽章 */}
          {hasVision ? (
            <span className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-ui-xs text-emerald-600 dark:text-emerald-400">
              <Eye className="size-3" />
              <span>{intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}</span>
            </span>
          ) : null}

          {hasReasoning ? (
            <span className="flex items-center gap-1 rounded border border-purple-500/20 bg-purple-500/10 px-1.5 py-0.5 text-ui-xs text-purple-600 dark:text-purple-400">
              <Lightbulb className="size-3" />
              <span>思考</span>
            </span>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {/* 上下文 / 最大 Token 胶囊 */}
          <span className="rounded border border-border bg-surface px-2 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {formatTokens(model.contextWindow)} · {formatTokens(model.maxTokens)}
          </span>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({
              id: expanded
                ? "settings.modelProvider.pi.collapse"
                : "settings.modelProvider.pi.expand",
            })}
            title={intl.formatMessage({
              id: expanded
                ? "settings.modelProvider.pi.collapse"
                : "settings.modelProvider.pi.expand",
            })}
            onClick={onToggle}
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
            aria-label={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            title={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 展开参数配置面板 */}
      {expanded ? (
        <div className="space-y-3.5 border-t border-border bg-surface/40 px-4 py-3.5 text-ui-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.modelId" })}>
              <Input size="lg" className="font-mono" disabled value={model.id} />
            </Field>

            <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.alias" })}>
              <Input
                size="lg"
                value={model.name === model.id ? "" : model.name}
                placeholder={intl.formatMessage({
                  id: "settings.modelProvider.pi.aliasPlaceholder",
                })}
                onChange={(event) => onPatch({ name: event.target.value.trim() || model.id })}
              />
            </Field>

            <Field
              className="sm:col-span-2"
              label={intl.formatMessage({ id: "settings.modelProvider.pi.modelApi" })}
            >
              <ApiSelect
                inheritLabel={intl.formatMessage({ id: "settings.modelProvider.pi.apiInherit" })}
                value={override || "inherit"}
                onChange={(value) => onPatch({ api: value === "inherit" ? null : value })}
              />
            </Field>

            {/* 上下文窗口 + 快捷预设胶囊 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{intl.formatMessage({ id: "settings.modelProvider.contextWindow" })}</Label>
                <PresetChips
                  presets={CONTEXT_PRESETS}
                  value={model.contextWindow}
                  onChange={(value) => onPatch({ contextWindow: value })}
                />
              </div>
              <Input
                size="lg"
                className="font-mono"
                type="number"
                value={model.contextWindow}
                onChange={(event) =>
                  onPatch({ contextWindow: Number(event.target.value) || model.contextWindow })
                }
              />
            </div>

            {/* 最大输出 Token + 快捷预设胶囊 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>
                  {intl.formatMessage({ id: "settings.modelProvider.maxOutputTokens" })}
                </Label>
                <PresetChips
                  presets={OUTPUT_PRESETS}
                  value={model.maxTokens}
                  onChange={(value) => onPatch({ maxTokens: value })}
                />
              </div>
              <Input
                size="lg"
                className="font-mono"
                type="number"
                value={model.maxTokens}
                onChange={(event) =>
                  onPatch({ maxTokens: Number(event.target.value) || model.maxTokens })
                }
              />
            </div>
          </div>

          {/* 输入模态配置 */}
          <div className="flex items-center gap-5 border-t border-border pt-2">
            <span className="text-ui-xs font-medium text-foreground-subtle shrink-0">
              {intl.formatMessage({ id: "settings.modelProvider.pi.inputType" })}:
            </span>
            <label className="flex items-center gap-1.5 cursor-pointer text-ui-base">
              <Checkbox checked disabled />
              <span>{intl.formatMessage({ id: "settings.modelProvider.pi.text" })}</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-ui-base">
              <Checkbox
                checked={model.input.includes("image")}
                onCheckedChange={(checked) =>
                  onPatch({ input: checked === true ? ["text", "image"] : ["text"] })
                }
              />
              <span>{intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}</span>
            </label>
          </div>

          {/* 思考等级列表配置 (Thinking Levels) */}
          <div className="space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center justify-between">
              <Label>
                {intl.formatMessage({ id: "settings.modelProvider.pi.thinkingLevels" })}
              </Label>
              <span className="text-ui-xs text-foreground-subtle">
                勾选该模型支持的思考强度档位
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {THINKING_LEVELS.map((level) => {
                const selected = model.thinkingLevels.includes(level);
                return (
                  <label
                    key={level}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-ui-sm cursor-pointer transition-colors",
                      selected
                        ? "border-primary/40 bg-surface text-foreground font-medium"
                        : "border-border bg-card text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    <Checkbox
                      checked={selected}
                      onCheckedChange={() => {
                        const thinkingLevels = selected
                          ? model.thinkingLevels.filter((item) => item !== level)
                          : [...model.thinkingLevels, level];
                        onPatch({ thinkingLevels });
                      }}
                    />
                    <span className="font-mono text-ui-xs">{level}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
