import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  Eye,
  Lightbulb,
  Loader2,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import type { CatalogModel } from "@/settings/provider-draft.js";
import { PickerMessage, PickerRow, SelectToggle } from "@/settings/ModelPickerRows.js";
import {
  annotateDiscovered,
  chosenFromDiscovered,
  defaultSelectedIds,
  type DiscoveredEntry,
  type DiscoveredModel,
} from "@/settings/model-picker-selection.js";

type PickerPhase = "loading" | "ready" | "failed";

/**
 * 「从端点拉取」的第二步：先让用户勾选，再一次性写回草稿。
 * discover 结果只活在这个弹窗里，取消或关闭即丢弃，不触碰草稿也不落盘。
 */
export function ModelPickerDialog({
  providerName,
  baseUrl,
  providerApi,
  existingModels,
  discover,
  onImport,
  onClose,
}: {
  providerName: string;
  baseUrl: string;
  providerApi: string;
  existingModels: CatalogModel[];
  discover: (force?: boolean) => Promise<DiscoveredModel[]>;
  onImport: (models: CatalogModel[]) => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [phase, setPhase] = useState<PickerPhase>("loading");
  const [entries, setEntries] = useState<DiscoveredEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [cappedCount, setCappedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const existingRef = useRef(existingModels);
  existingRef.current = existingModels;

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    void discover(attempt > 0).then(
      (list) => {
        if (cancelled) return;
        const next = annotateDiscovered(list, existingRef.current);
        const initial = defaultSelectedIds(next);
        setEntries(next);
        setSelectedIds(initial.ids);
        setCappedCount(initial.capped ? initial.ids.length : 0);
        setPhase("ready");
      },
      () => {
        if (!cancelled) setPhase("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, discover]);

  const addable = useMemo(() => entries.filter((entry) => !entry.alreadyAdded), [entries]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (onlyNew && entry.alreadyAdded) return false;
      if (!q) return true;
      return entry.id.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q);
    });
  }, [entries, onlyNew, query]);

  const toggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const allSelected = addable.length > 0 && addable.every((entry) => selectedSet.has(entry.id));
  const someSelected = addable.some((entry) => selectedSet.has(entry.id));
  const importSelected = () => {
    const chosen = chosenFromDiscovered(entries, selectedIds);
    if (chosen.length > 0) onImport(chosen);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(36rem,calc(100dvh-2rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 flex-row items-start justify-between border-b border-border px-5 py-3.5 pr-12">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="text-ui-base font-semibold">
                {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.title" })}
              </DialogTitle>
              {phase === "ready" ? (
                <span className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.modelProvider.pi.pickModels.discovered" },
                    { count: entries.length },
                  )}
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
              <span className="truncate">{providerName}</span>
              <span className="text-foreground-subtlest">·</span>
              <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
                {baseUrl}
              </span>
            </div>
          </div>
        </DialogHeader>

        {phase === "ready" ? (
          <>
            {cappedCount > 0 ? (
              <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-ui-sm text-foreground">
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                  {intl.formatMessage(
                    { id: "settings.modelProvider.pi.pickModels.defaultCapped" },
                    { count: cappedCount },
                  )}
                </span>
              </div>
            ) : null}

            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
              <div className="relative min-w-40 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
                <Input
                  size="lg"
                  className="pl-8 text-ui-sm"
                  placeholder={intl.formatMessage({
                    id: "settings.modelProvider.pi.pickModels.search",
                  })}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className={cn("gap-1.5 px-2.5", onlyNew && "bg-selected text-foreground")}
                aria-pressed={onlyNew}
                onClick={() => setOnlyNew((current) => !current)}
              >
                <Eye className="size-3.5" />
                <span>
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.onlyNew" })}
                </span>
              </Button>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-5 py-2 text-ui-sm text-foreground-subtle">
              <SelectToggle
                checked={allSelected ? true : someSelected ? "mixed" : false}
                disabled={addable.length === 0}
                label={intl.formatMessage({
                  id: "settings.modelProvider.pi.pickModels.selectAll",
                })}
                onChange={(next) => setSelectedIds(next ? addable.map((entry) => entry.id) : [])}
              />
              <span>
                {intl.formatMessage(
                  { id: "settings.modelProvider.pi.pickModels.selected" },
                  { count: selectedIds.length, visible: visibleEntries.length },
                )}
              </span>
            </div>

            <div className="mx-5 my-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card">
              {entries.length === 0 ? (
                <PickerMessage
                  title={intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.empty" })}
                  description={intl.formatMessage({
                    id: "settings.modelProvider.pi.pickModels.emptyHint",
                  })}
                  actionLabel={intl.formatMessage({
                    id: "settings.modelProvider.pi.pickModels.manualHint",
                  })}
                  onAction={onClose}
                />
              ) : addable.length === 0 ? (
                <PickerMessage
                  title={intl.formatMessage(
                    { id: "settings.modelProvider.pi.pickModels.allAdded" },
                    { count: entries.length },
                  )}
                  description={intl.formatMessage({
                    id: "settings.modelProvider.pi.pickModels.allAddedHint",
                  })}
                  actionLabel={intl.formatMessage({
                    id: "settings.modelProvider.pi.pickModels.done",
                  })}
                  onAction={onClose}
                />
              ) : visibleEntries.length === 0 ? (
                <p className="p-6 text-center text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.noMatch" })}
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {visibleEntries.map((entry) => (
                    <PickerRow
                      key={entry.id}
                      entry={entry}
                      providerApi={providerApi}
                      selected={selectedSet.has(entry.id)}
                      onToggle={() => toggle(entry.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 py-14 text-center">
            {phase === "loading" ? (
              <>
                <Loader2 className="size-4 animate-spin text-foreground-subtle" />
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.loading" })}
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="size-5 text-warning" />
                <p className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.failed" })}
                </p>
                <p className="max-w-sm text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.failedHint" })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="mt-1"
                  onClick={() => setAttempt((current) => current + 1)}
                >
                  <RotateCw className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.retry" })}
                </Button>
              </>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t border-border px-5 py-3 sm:justify-between">
          <span className="hidden text-ui-xs text-foreground-subtlest sm:inline">
            {intl.formatMessage({ id: "settings.modelProvider.pi.pickModels.footNote" })}
          </span>
          <div className="flex flex-1 gap-2 sm:flex-none">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1 sm:flex-none"
              onClick={onClose}
            >
              <X />
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="flex-1 sm:flex-none"
              disabled={phase !== "ready" || selectedIds.length === 0}
              onClick={importSelected}
            >
              <Download />
              {intl.formatMessage(
                {
                  id:
                    selectedIds.length > 0
                      ? "settings.modelProvider.pi.pickModels.importCount"
                      : "settings.modelProvider.pi.pickModels.importEmpty",
                },
                { count: selectedIds.length },
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
