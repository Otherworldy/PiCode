import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** `0` = 只保留 frontmatter `expires` 的显式到期，不再按闲置天数清理。 */
export const WORKSPACE_MEMORY_NEVER_EXPIRE_DAYS = 0;

/** 预设阈值（天）。默认 90 与 `WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS` 一致。 */
export const WORKSPACE_MEMORY_EXPIRY_PRESETS = [7, 30, 90, 180, 365] as const;

export function toWorkspaceMemoryExpiryValue(days: number): string {
  return String(days);
}

export function fromWorkspaceMemoryExpiryValue(value: string): number | null {
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : null;
}

export function WorkspaceMemoryExpirySelect({
  disabled,
  value,
  onChange,
}: {
  disabled: boolean;
  /** null 表示阈值还在读取；此时只显示占位，不伪造默认值。 */
  value: number | null;
  onChange: (days: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (value === null) {
    return (
      <Select disabled value="__loading__">
        <SelectTrigger className="w-64 shrink-0" size="lg">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__loading__">—</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  // 配置里可能是预设之外的值（例如手写了 45）：补一个选项，避免选择器显示空值。
  const isPreset =
    value === WORKSPACE_MEMORY_NEVER_EXPIRE_DAYS ||
    WORKSPACE_MEMORY_EXPIRY_PRESETS.includes(
      value as (typeof WORKSPACE_MEMORY_EXPIRY_PRESETS)[number],
    );
  const presets = isPreset
    ? [...WORKSPACE_MEMORY_EXPIRY_PRESETS]
    : [...WORKSPACE_MEMORY_EXPIRY_PRESETS, value];
  return (
    <Select
      disabled={disabled}
      value={toWorkspaceMemoryExpiryValue(value)}
      onValueChange={(next) => {
        const days = fromWorkspaceMemoryExpiryValue(next);
        if (days !== null) onChange(days);
      }}
    >
      <SelectTrigger className="w-64 shrink-0" size="lg">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {presets.map((days) => (
          <SelectItem key={days} value={toWorkspaceMemoryExpiryValue(days)}>
            {intl.formatMessage({ id: "settings.memory.expiryDaysValue" }, { days })}
          </SelectItem>
        ))}
        <SelectItem value={toWorkspaceMemoryExpiryValue(WORKSPACE_MEMORY_NEVER_EXPIRE_DAYS)}>
          {intl.formatMessage({ id: "settings.memory.expiryDaysNever" })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
