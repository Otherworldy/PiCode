import { useEffect, useMemo, useState } from "react";
import type { ModelSelection, TodoItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function TodoStartDialog({
  item,
  onCancel,
  onConfirm,
}: {
  item: TodoItem;
  onCancel: () => void;
  onConfirm: (selection: ModelSelection) => void;
}) {
  const { intl } = useZCodeIntl();
  const read = useModelSelectionView(item.workspacePath, null, item.workspaceIdentity);
  const view = read.state.status === "ready" ? read.state.view : null;
  const models = useMemo(
    () =>
      view?.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          providerId: provider.providerId,
          providerName: provider.providerName?.trim() || provider.providerId,
          modelId: model.modelId,
          levels: [...(model.config.optionSpecs.reasoningLevel?.values ?? [])],
        })),
      ) ?? [],
    [view],
  );
  const [index, setIndex] = useState<number | null>(null);
  const [level, setLevel] = useState("");
  const selected = index != null ? models[index] : undefined;

  useEffect(() => {
    const preferred = view?.preferredSelection;
    if (!preferred || models.length === 0 || index != null) return;
    const found = models.findIndex(
      (model) => model.providerId === preferred.providerId && model.modelId === preferred.modelId,
    );
    if (found < 0) return;
    setIndex(found);
    const preferredLevel = preferred.options?.reasoningLevel ?? "";
    setLevel(models[found]?.levels.includes(preferredLevel) ? preferredLevel : "");
  }, [index, models, view?.preferredSelection]);

  const levels = selected?.levels ?? [];
  const ready = selected != null && (levels.length === 0 || levels.includes(level));

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>开始 {item.title}</DialogTitle>
        </DialogHeader>
        {read.state.status === "loading" ? (
          <p className="text-ui-sm text-foreground-subtle">正在读取模型…</p>
        ) : models.length === 0 ? (
          <p className="text-ui-sm text-destructive">没有可选模型。</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select
              value={index == null ? undefined : String(index)}
              onValueChange={(value) => {
                const next = Number(value);
                setIndex(next);
                const nextLevels = models[next]?.levels ?? [];
                setLevel(nextLevels.includes(level) ? level : "");
              }}
            >
              <SelectTrigger size="lg" variant="outline" className="w-full" aria-label="模型">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {models.map((model, modelIndex) => (
                  <SelectItem key={`${model.providerId}/${model.modelId}`} value={String(modelIndex)}>
                    {model.providerName} / {model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {levels.length > 0 ? (
              <Select value={level || undefined} onValueChange={setLevel}>
                <SelectTrigger size="lg" variant="outline" className="w-full" aria-label="思考等级">
                  <SelectValue placeholder="选择思考等级" />
                </SelectTrigger>
                <SelectContent>
                  {levels.map((entry) => {
                    const labelId = thoughtLevelLabelId(entry);
                    return (
                      <SelectItem key={entry} value={entry}>
                        {labelId ? intl.formatMessage({ id: labelId }) : entry}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!ready || !selected}
            onClick={() => {
              if (!selected || !ready) return;
              onConfirm(
                level
                  ? {
                      providerId: selected.providerId,
                      modelId: selected.modelId,
                      options: { reasoningLevel: level },
                    }
                  : { providerId: selected.providerId, modelId: selected.modelId },
              );
            }}
          >
            开始
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
