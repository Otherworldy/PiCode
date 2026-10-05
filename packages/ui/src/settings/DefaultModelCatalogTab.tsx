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
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";

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
  onDefaultModelChange,
  onDefaultThoughtChange,
  onGoToProviders,
  onAddProvider,
}: {
  loading: boolean;
  hasView: boolean;
  allModels: readonly FlatModelEntry[];
  currentDefault: FlatModelEntry | null;
  defaultValue: string;
  defaultThought?: string;
  onDefaultModelChange: (value: string) => void;
  onDefaultThoughtChange: (thought: string) => void;
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
          <Button type="button" className="mt-4 gap-1.5" size="sm" onClick={onAddProvider}>
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
              <SelectTrigger className="w-full">
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
                <SelectTrigger className="w-full">
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

      {currentDefault ? (
        <SettingsGroupCard>
          <div className="px-4 py-3">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.pi.currentModelSpecs" })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle ring-1 ring-border">
                {currentDefault.providerName}
              </span>
              <span className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle ring-1 ring-border">
                {currentDefault.model.id}
              </span>
              <span className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle ring-1 ring-border">
                {currentDefault.model.api || currentDefault.providerApi}
              </span>
              {currentDefault.model.input.includes("image") ? (
                <span className="rounded-md bg-surface px-2 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.vision" })}
                </span>
              ) : null}
              {currentDefault.model.contextWindow ? (
                <span className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle ring-1 ring-border">
                  {intl.formatMessage({ id: "settings.modelProvider.contextWindow" })}:{" "}
                  {currentDefault.model.contextWindow}
                </span>
              ) : null}
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
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
