import type { WorkspaceMemoryModelRef } from "@picode/services";
import { TID_WORKSPACE_MEMORY_SWITCH } from "@picode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { WorkspaceMemoryExpirySelect } from "./WorkspaceMemoryExpirySelect.js";
import {
  toWorkspaceMemoryModelValue,
  WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL,
  WorkspaceMemoryModelSelect,
} from "./WorkspaceMemoryModelSelect.js";

export function WorkspaceMemorySettingsRows({
  disabled,
  enabled,
  expiryDays,
  memoryModel,
  modelOptions,
  onEnabledChange,
  onExpiryDaysChange,
  onModelChange,
}: {
  disabled: boolean;
  enabled: boolean;
  expiryDays: number | null;
  memoryModel: WorkspaceMemoryModelRef | null;
  modelOptions: { value: string; label: string }[];
  onEnabledChange: (enabled: boolean) => void;
  onExpiryDaysChange: (days: number) => void;
  onModelChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 已保存的模型可能已经从 Pi 目录删除；仍旧把它显示出来，避免选择器变成空值。
  const selectedModelValue = memoryModel
    ? toWorkspaceMemoryModelValue(memoryModel)
    : WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL;
  const visibleModelOptions =
    memoryModel && !modelOptions.some((option) => option.value === selectedModelValue)
      ? [
          {
            value: selectedModelValue,
            label: `${memoryModel.providerId} / ${memoryModel.modelId}`,
          },
          ...modelOptions,
        ]
      : modelOptions;
  return (
    <SettingsGroupCard>
      <SettingsRow
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.memory.workspaceMemory" })}
            checked={enabled}
            data-testid={TID_WORKSPACE_MEMORY_SWITCH}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
          />
        }
        description={intl.formatMessage({ id: "settings.memoryDescription" })}
        label={intl.formatMessage({ id: "settings.memory.workspaceMemory" })}
      />
      <SettingsRow
        control={
          <WorkspaceMemoryModelSelect
            disabled={disabled}
            options={visibleModelOptions}
            value={selectedModelValue}
            onChange={onModelChange}
          />
        }
        controlLayout="wide"
        description={intl.formatMessage({ id: "settings.memory.extractionModelDescription" })}
        label={intl.formatMessage({ id: "settings.memory.extractionModel" })}
      />
      <SettingsRow
        control={
          <WorkspaceMemoryExpirySelect
            disabled={disabled || expiryDays === null}
            value={expiryDays}
            onChange={onExpiryDaysChange}
          />
        }
        description={intl.formatMessage({ id: "settings.memory.expiryDaysDescription" })}
        label={intl.formatMessage({ id: "settings.memory.expiryDays" })}
      />
    </SettingsGroupCard>
  );
}

export { WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL };
