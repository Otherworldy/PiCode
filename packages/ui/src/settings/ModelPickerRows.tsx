import { Check } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { formatTokens } from "@/settings/provider-draft.js";
import type { DiscoveredEntry } from "@/settings/model-picker-selection.js";

/** 整行可点、可键盘操作的多选控件，避免在 label 里嵌一个不可被 label 激活的按钮。 */
export function SelectToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean | "mixed";
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === "mixed" ? "mixed" : checked}
      disabled={disabled}
      onClick={() => onChange(checked !== true)}
      className="flex items-center gap-2 rounded-md text-ui-sm text-foreground-subtle transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
          checked !== false && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {checked === true ? <Check className="size-3" /> : null}
        {checked === "mixed" ? <span className="h-px w-2 bg-current" /> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function PickerRow({
  entry,
  providerApi,
  selected,
  onToggle,
}: {
  entry: DiscoveredEntry;
  providerApi: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const { intl } = useZCodeIntl();
  const checked = entry.alreadyAdded || selected;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={entry.id}
      disabled={entry.alreadyAdded}
      onClick={onToggle}
      className={cn(
        "flex w-full flex-wrap items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
        entry.alreadyAdded ? "cursor-default opacity-55" : "hover:bg-hover",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
          checked && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="truncate font-mono text-ui-base font-semibold text-foreground">
          {entry.id}
        </span>
        {entry.name && entry.name !== entry.id ? (
          <span className="truncate text-ui-xs text-foreground-subtle">{entry.name}</span>
        ) : null}
        <span className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
          {providerApi}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {entry.contextWindow !== undefined || entry.maxTokens !== undefined ? (
          <span className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {formatTokens(entry.contextWindow ?? 0)} · {formatTokens(entry.maxTokens ?? 0)}
          </span>
        ) : null}
        {entry.alreadyAdded ? (
          <span className="rounded-sm bg-tag px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.alreadyAdded" })}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function PickerMessage({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
      <p className="text-ui-base font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-ui-sm text-foreground-subtle">{description}</p>
      <Button type="button" variant="outline" size="lg" className="mt-1" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
