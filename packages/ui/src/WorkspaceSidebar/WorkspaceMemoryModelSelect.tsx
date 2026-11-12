import type { WorkspaceMemoryModelRef } from "@picode/services";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export const WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL = "__follow_session__";

export function toWorkspaceMemoryModelValue(model: WorkspaceMemoryModelRef): string {
  return `${model.providerId}::${model.modelId}`;
}

export function fromWorkspaceMemoryModelValue(value: string): WorkspaceMemoryModelRef | null {
  if (value === WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL) return null;
  const separator = value.indexOf("::");
  if (separator <= 0) return null;
  return {
    providerId: value.slice(0, separator),
    modelId: value.slice(separator + 2),
  };
}

export function WorkspaceMemoryModelSelect({
  disabled,
  options,
  value,
  onChange,
}: {
  disabled: boolean;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" size="lg">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={WORKSPACE_MEMORY_FOLLOW_SESSION_MODEL}>
          {intl.formatMessage({ id: "settings.memory.extractionModelFollow" })}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
