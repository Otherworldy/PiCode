import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, PlugZap, X } from "lucide-react";
import type { ZCodePiModelsMutateParams } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ApiSelect, Field, ModelDraftList } from "@/settings/ModelDraftCard.js";
import {
  SERVICE_PRESETS,
  defaultChosen,
  slugProviderId,
  type CatalogView,
  type ProviderDraft,
} from "@/settings/provider-draft.js";

export function ProviderSetupDialog({
  busy,
  draft,
  existingIds,
  mutate,
  onClose,
  onChange,
}: {
  busy: boolean;
  draft: ProviderDraft | null;
  existingIds: string[];
  mutate: (params: ZCodePiModelsMutateParams) => Promise<CatalogView>;
  onClose: () => void;
  onChange: (draft: ProviderDraft | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [step, setStep] = useState<1 | 2>(1);
  const [preset, setPreset] = useState("custom");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dialogOpen = Boolean(draft);
  const dialogSeed = draft ? `${draft.existing ? "e" : "n"}:${draft.id}` : "";

  useEffect(() => {
    setStep(1);
    setPreset("custom");
  }, [dialogOpen, dialogSeed]);

  const patch = (partial: Partial<ProviderDraft>) => {
    const current = draftRef.current;
    if (!current) return;
    onChange({ ...current, ...partial });
  };

  const fetchModels = async (importModels: boolean) => {
    const current = draftRef.current;
    if (!current?.baseUrl.trim()) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    try {
      const next = await mutate({
        action: "discover",
        providerId: current.id.trim() || undefined,
        provider: {
          id: current.id.trim() || "tmp",
          baseUrl: current.baseUrl.trim(),
          api: current.api,
          ...(current.apiKey.trim() ? { apiKey: current.apiKey.trim() } : {}),
          models: [],
        },
      });
      const list = next.discovered ?? [];
      const latest = draftRef.current ?? current;
      if (importModels) {
        const known = new Set(latest.models.map((model) => model.id));
        const added = list.filter((item) => !known.has(item.id)).map(defaultChosen);
        if (added.length > 0) onChange({ ...latest, models: [...latest.models, ...added] });
      }
      toast(
        intl.formatMessage({ id: "settings.modelProvider.pi.discoverOk" }, { count: list.length }),
      );
    } catch {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.discoverFailed" }));
    }
  };

  const goNext = () => {
    const current = draftRef.current;
    if (!current?.name.trim() || !current.baseUrl.trim()) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    setStep(2);
  };

  const save = async () => {
    const current = draftRef.current;
    if (!current) return;
    const name = current.name.trim();
    const baseUrl = current.baseUrl.trim();
    if (!name || !baseUrl) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      setStep(1);
      return;
    }
    if (current.models.length === 0) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needModels" }));
      return;
    }
    const id = current.existing ? current.id : current.id.trim() || slugProviderId(name, baseUrl);
    if (!current.existing && existingIds.includes(id)) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.duplicateId" }));
      setStep(1);
      return;
    }
    await mutate({
      action: "upsert",
      provider: {
        id,
        name,
        baseUrl,
        api: current.api,
        apiKey: current.apiKey.trim(),
        models: current.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.thinkingLevels.some((level) => level !== "off"),
          thinkingLevels: model.thinkingLevels,
          ...(model.defaultThinkingLevel
            ? { defaultThinkingLevel: model.defaultThinkingLevel }
            : {}),
          input: model.input,
          ...(model.api && model.api !== current.api ? { api: model.api } : {}),
        })),
      },
    });
    onClose();
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(40rem,calc(100dvh-2rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-3 border-b border-border px-5 py-4 pr-12">
          <DialogTitle>
            {intl.formatMessage({
              id: draft?.existing
                ? "settings.modelProvider.pi.editService"
                : "settings.modelProvider.pi.addService",
            })}
          </DialogTitle>
          <div className="flex items-center gap-2 text-ui-sm">
            <StepChip
              active={step === 1}
              done={step === 2}
              index={1}
              label={intl.formatMessage({ id: "settings.modelProvider.pi.stepEndpoint" })}
              onClick={() => setStep(1)}
            />
            <span className="h-px w-8 bg-border" />
            <StepChip
              active={step === 2}
              done={false}
              index={2}
              label={intl.formatMessage({ id: "settings.modelProvider.pi.stepModels" })}
              onClick={goNext}
            />
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
        {draft && step === 1 ? (
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
            <Field
              className="sm:col-span-2"
              label={intl.formatMessage({ id: "settings.modelProvider.pi.service" })}
            >
              <Select
                value={preset}
                onValueChange={(value) => {
                  setPreset(value);
                  const selected = SERVICE_PRESETS.find((item) => item.value === value);
                  if (!selected || !("name" in selected)) return;
                  patch({
                    name: selected.name,
                    baseUrl: selected.baseUrl,
                    api: selected.api,
                    ...(draft.existing ? {} : { id: selected.value }),
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_PRESETS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {"name" in item
                        ? item.name
                        : intl.formatMessage({ id: "settings.modelProvider.pi.serviceCustom" })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={intl.formatMessage({ id: "settings.modelProvider.name" })}>
              <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
            </Field>
            <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.providerId" })}>
              <Input
                className="font-mono"
                disabled={draft.existing}
                value={draft.id}
                onChange={(event) => patch({ id: event.target.value })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              label={intl.formatMessage({ id: "settings.modelProvider.pi.baseUrl" })}
            >
              <Input
                className="font-mono"
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              label={intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
            >
              <Input
                className="font-mono"
                value={draft.apiKey}
                onChange={(event) => patch({ apiKey: event.target.value })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              label={intl.formatMessage({ id: "settings.modelProvider.pi.defaultApi" })}
            >
              <ApiSelect value={draft.api} onChange={(value) => patch({ api: value })} />
            </Field>
          </div>
        ) : null}

        {draft && step === 2 ? (
          <ModelDraftList
            busy={busy}
            draft={draft}
            onChange={onChange}
            onFetch={() => void fetchModels(true)}
          />
        ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3 sm:justify-between">
          {step === 1 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void fetchModels(false)}
            >
              <PlugZap />
              {intl.formatMessage({ id: "settings.modelProvider.pi.testConnection" })}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setStep(1)}>
              <ArrowLeft />
              {intl.formatMessage({ id: "settings.modelProvider.pi.back" })}
            </Button>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              <X />
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            {step === 1 ? (
              <Button type="button" size="sm" onClick={goNext}>
                {intl.formatMessage({ id: "settings.modelProvider.pi.next" })}
                <ArrowRight />
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
                <Check />
                {intl.formatMessage({ id: "settings.modelProvider.pi.saveService" })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepChip({
  active,
  done,
  index,
  label,
  onClick,
}: {
  active: boolean;
  done: boolean;
  index: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("flex items-center gap-1.5", active ? "text-primary" : "text-foreground-subtle")}
      onClick={onClick}
    >
      <span
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full text-ui-xs",
          active && "bg-primary text-primary-foreground",
          done && "bg-success text-background",
          !active && !done && "border border-border",
        )}
      >
        {index}
      </span>
      {label}
    </button>
  );
}
