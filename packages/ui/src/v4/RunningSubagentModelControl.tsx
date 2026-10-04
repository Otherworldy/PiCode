import { useMemo, useState } from "react";
import { ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

const THOUGHT_LABEL_IDS: Record<string, string> = {
  off: "chat.toolbar.thoughtLevel.value.off",
  minimal: "chat.toolbar.thoughtLevel.value.minimal",
  low: "chat.toolbar.thoughtLevel.value.low",
  medium: "chat.toolbar.thoughtLevel.value.medium",
  high: "chat.toolbar.thoughtLevel.value.high",
  xhigh: "chat.toolbar.thoughtLevel.value.xhigh",
  max: "chat.toolbar.thoughtLevel.value.max",
  ultra: "chat.toolbar.thoughtLevel.value.ultra",
};

export function RunningSubagentModelControl({
  disabled = false,
  modelId,
  modelProvider,
  modelSelectionView,
  onChange,
  provider,
  thought = "",
}: {
  disabled?: boolean;
  modelId: string;
  modelProvider: string;
  modelSelectionView?: ModelSelectionView | null;
  onChange?: (next: { provider: string; model: string; thought: string }) => void | Promise<void>;
  provider?: ZCodeProvider;
  thought?: string;
}) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const formatLevelName = (level: string) => {
    const id = THOUGHT_LABEL_IDS[level];
    return id ? intl.formatMessage({ id }) : level;
  };
  const modelGroups = useMemo(
    () =>
      modelSelectionView
        ? buildRegistryModelSelectGroups(provider ?? ZCODE_AGENT_PROVIDER, modelSelectionView)
        : [],
    [modelSelectionView, provider],
  );
  const encoded = encodeCustomModelValue(modelProvider, modelId);
  const thoughtOption =
    modelSelectionView && modelProvider && modelId
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: modelProvider,
          modelId,
          currentValue: thought,
          formatLevelName,
        })
      : null;
  const thoughtLabel = thought ? formatLevelName(thought) : "";
  const locked = disabled || pending || !onChange;

  const commit = (next: { provider: string; model: string; thought: string }) => {
    if (!onChange || pending) return;
    if (next.provider === modelProvider && next.model === modelId && next.thought === thought) return;
    setPending(true);
    void Promise.resolve(onChange(next)).finally(() => setPending(false));
  };

  if (modelGroups.length === 0 || !onChange) {
    return (
      <span className="pointer-events-none text-ui-sm text-[var(--color-foreground-subtle)]">
        {modelId}
        {thoughtLabel ? ` · ${thoughtLabel}` : ""}
      </span>
    );
  }

  return (
    <span
      className="pointer-events-auto relative z-[2] inline-flex min-w-0 flex-wrap items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ModelConfigSelect
        modelGroups={modelGroups}
        normalizedValue={encoded}
        triggerLabel={modelId}
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={() => false}
        disabled={locked}
        contentSide="top"
        contentAlign="end"
        focusSelectorOnClose={null}
        labelVisibilityClassName="inline-flex min-w-0"
        triggerClassName="h-6 w-fit max-w-40 min-w-0 justify-between rounded-md border border-[var(--color-border)] bg-transparent px-1.5 py-0 text-ui-sm text-[var(--color-foreground)]"
        triggerLabelClassName="inline-flex min-w-0 truncate text-left"
        onValueChange={(value) => {
          const decoded = decodeCustomModelValue(value);
          if (!decoded?.providerId || !decoded.modelName || !modelSelectionView) return;
          const option = resolveModelThoughtOption({
            modelSelectionView,
            providerId: decoded.providerId,
            modelId: decoded.modelName,
            currentValue: thought,
            formatLevelName,
          });
          const nextThought =
            option?.type === "select" && typeof option.currentValue === "string" && option.currentValue
              ? option.currentValue
              : (option?.options?.at(-1)?.value ?? thought);
          commit({
            provider: decoded.providerId,
            model: decoded.modelName,
            thought: nextThought,
          });
        }}
      />
      <SubagentReasoningField
        intl={intl}
        disabled={locked}
        labelVisibilityClassName="inline-flex"
        state={
          thoughtOption
            ? { kind: "supported", option: thoughtOption }
            : { kind: "unsupported" }
        }
        onValueCommit={(nextThought) => {
          commit({ provider: modelProvider, model: modelId, thought: nextThought });
        }}
      />
    </span>
  );
}
