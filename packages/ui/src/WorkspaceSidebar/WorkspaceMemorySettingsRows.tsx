import type { WorkspaceMemoryModelRef } from "@zcode/services";
import { TID_WORKSPACE_MEMORY_SWITCH } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  toWorkspaceMemoryModelValue,
  WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL,
  WorkspaceMemoryModelSelect,
} from "./WorkspaceMemoryModelSelect.js";

export function WorkspaceMemorySettingsRows({
  disabled,
  enabled,
  memoryModel,
  modelOptions,
  onEnabledChange,
  onModelChange,
}: {
  disabled: boolean;
  enabled: boolean;
  memoryModel: WorkspaceMemoryModelRef | null;
  modelOptions: { value: string; label: string }[];
  onEnabledChange: (enabled: boolean) => void;
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
    <>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.memory.workspaceMemory" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.memoryDescription" })}
          </p>
        </div>
        <Switch
          aria-label={intl.formatMessage({ id: "settings.memory.workspaceMemory" })}
          checked={enabled}
          data-testid={TID_WORKSPACE_MEMORY_SWITCH}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
        />
      </div>

      <div className="flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.memory.extractionModel" })}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.memory.extractionModelDescription" })}
          </p>
        </div>
        <WorkspaceMemoryModelSelect
          disabled={disabled}
          options={visibleModelOptions}
          value={selectedModelValue}
          onChange={onModelChange}
        />
      </div>
    </>
  );
}

export { WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL };
