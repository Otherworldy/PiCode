import { ArrowRight, Plus } from "lucide-react";
import type { ZCodePiProviderModelView } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";

export const TITLE_SUMMARY_FOLLOW_VALUE = "__follow__";

export interface FlatModelEntry {
  providerId: string;
  providerName: string;
  providerApi: string;
  model: ZCodePiProviderModelView;
}

export function DefaultModelCatalogTab({
  loading,
  hasView,
  allModels,
  currentDefault,
  defaultValue,
  defaultThought,
  titleSummaryEnabled,
  titleSummaryValue,
  onDefaultModelChange,
  onDefaultThoughtChange,
  onTitleSummaryEnabledChange,
  onTitleSummaryModelChange,
  onGoToProviders,
  onAddProvider,
}: {
  loading: boolean;
  hasView: boolean;
  allModels: readonly FlatModelEntry[];
  currentDefault: FlatModelEntry | null;
  defaultValue: string;
  defaultThought?: string;
  titleSummaryEnabled: boolean;
  titleSummaryValue: string;
  onDefaultModelChange: (value: string) => void;
  onDefaultThoughtChange: (thought: string) => void;
  onTitleSummaryEnabledChange: (enabled: boolean) => void;
  onTitleSummaryModelChange: (value: string) => void;
  onGoToProviders: () => void;
  onAddProvider: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (loading && !hasView) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.pi.loading" })}
      </p>
    );
  }

  if (allModels.length === 0) {
    return (
      <SettingsGroupCard>
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.pi.noModelsConfigured" })}
          </p>
          <Button type="button" className="mt-4 gap-1.5" size="lg" onClick={onAddProvider}>
            <Plus className="size-4" />
            {intl.formatMessage({ id: "settings.modelProvider.pi.goToAddProvider" })}
          </Button>
        </div>
      </SettingsGroupCard>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProvider.pi.defaultModel" })}
          description={intl.formatMessage({ id: "settings.modelProvider.pi.defaultModelDesc" })}
          controlLayout="wide"
          control={
            <Select value={defaultValue} onValueChange={onDefaultModelChange}>
              <SelectTrigger size="lg" className="w-full">
                <SelectValue
                  placeholder={intl.formatMessage({ id: "settings.modelProvider.pi.defaultModel" })}
                />
              </SelectTrigger>
              <SelectContent>
                {allModels.map(({ providerId, providerName, model }) => (
                  <SelectItem key={`${providerId}/${model.id}`} value={`${providerId}/${model.id}`}>
                    {providerName}/{model.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {currentDefault && currentDefault.model.thinkingLevels.length > 0 ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.modelProvider.pi.defaultThought" })}
            description={intl.formatMessage({
              id: "settings.modelProvider.pi.defaultThoughtDesc",
            })}
            controlLayout="wide"
            control={
              <Select
                value={
                  defaultThought && currentDefault.model.thinkingLevels.includes(defaultThought)
                    ? defaultThought
                    : (currentDefault.model.thinkingLevels[0] ?? "medium")
                }
                onValueChange={onDefaultThoughtChange}
              >
                <SelectTrigger size="lg" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currentDefault.model.thinkingLevels.map((lvl: string) => {
                    const labelId = thoughtLevelLabelId(lvl);
                    return (
                      <SelectItem key={lvl} value={lvl}>
                        {labelId ? intl.formatMessage({ id: labelId }) : lvl}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProvider.pi.titleSummary" })}
          description={intl.formatMessage({ id: "settings.modelProvider.pi.titleSummaryDesc" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.modelProvider.pi.titleSummary" })}
              checked={titleSummaryEnabled}
              onCheckedChange={onTitleSummaryEnabledChange}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.modelProvider.pi.titleSummaryModel" })}
          description={intl.formatMessage({
            id: "settings.modelProvider.pi.titleSummaryModelDesc",
          })}
          controlLayout="wide"
          control={
            <Select
              value={titleSummaryValue}
              onValueChange={onTitleSummaryModelChange}
              disabled={!titleSummaryEnabled}
            >
              <SelectTrigger size="lg" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TITLE_SUMMARY_FOLLOW_VALUE}>
                  {intl.formatMessage({ id: "settings.modelProvider.pi.titleSummaryFollow" })}
                </SelectItem>
                {allModels.map(({ providerId, providerName, model }) => (
                  <SelectItem key={`${providerId}/${model.id}`} value={`${providerId}/${model.id}`}>
                    {providerName}/{model.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      {currentDefault ? (
        <SettingsGroupCard>
          <div className="px-4 py-3">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.pi.currentModelSpecs" })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-surface px-2.5 py-1 font-mono text-ui-base text-foreground-subtle ring-1 ring-border">
                {currentDefault.providerName}
              </span>
              <span className="rounded-md bg-surface px-2.5 py-1 font-mono text-ui-base text-foreground-subtle ring-1 ring-border">
                {currentDefault.model.id}
              </span>
              <span className="rounded-md bg-surface px-2.5 py-1 font-mono text-ui-base text-foreground-subtle ring-1 ring-border">
                {currentDefault.model.api || currentDefault.providerApi}
              </span>
              {currentDefault.model.input.includes("image") ? (
                <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base text-foreground-subtle ring-1 ring-border">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}
                </span>
              ) : null}
              {currentDefault.model.contextWindow ? (
                <span className="rounded-md bg-surface px-2.5 py-1 font-mono text-ui-base text-foreground-subtle ring-1 ring-border">
                  {intl.formatMessage({ id: "settings.modelProvider.contextWindow" })}:{" "}
                  {currentDefault.model.contextWindow}
                </span>
              ) : null}
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}

      <div className="flex justify-end pt-1">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="gap-1.5"
          onClick={onGoToProviders}
        >
          {intl.formatMessage({ id: "settings.modelProvider.pi.manageProviders" })}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
