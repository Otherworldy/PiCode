import { Emitter, type Event } from "@zcode/rpc";
import type { ModelSelectionView } from "@zcode/provider";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";

export interface PiCatalogModel {
  providerId: string;
  modelId: string;
  name?: string;
  thoughtLevels?: readonly string[];
}

export interface PiModelCatalogSnapshot {
  models: readonly PiCatalogModel[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThought?: string;
}

const FALLBACK_THOUGHTS = ["off", "low", "medium", "high"] as const;
const changed = new Emitter<ModelSelectionView>();
let current: ModelSelectionView | null = null;
let snapshot: PiModelCatalogSnapshot | null = null;
let revision = 1;

function thoughtsOf(model: PiCatalogModel): string[] {
  return model.thoughtLevels && model.thoughtLevels.length > 0
    ? [...model.thoughtLevels]
    : [...FALLBACK_THOUGHTS];
}

export function toPiModelSelectionView(catalog: PiModelCatalogSnapshot): ModelSelectionView {
  const groups = new Map<string, PiCatalogModel[]>();
  for (const model of catalog.models) {
    const list = groups.get(model.providerId);
    if (list) list.push(model);
    else groups.set(model.providerId, [model]);
  }
  const providers = [...groups.entries()].map(([providerId, models]) => ({
    providerId,
    providerName: providerId,
    templateId: "custom",
    config: { api: { type: "openai-chat-completions" as const } },
    models: models.map((model) => ({
      modelId: model.modelId,
      config: {
        optionSpecs: {
          reasoningLevel: { values: thoughtsOf(model) },
        },
      },
    })),
  }));
  const preferredModel =
    catalog.defaultProvider && catalog.defaultModel
      ? catalog.models.find(
          (model) =>
            model.providerId === catalog.defaultProvider && model.modelId === catalog.defaultModel,
        )
      : catalog.models[0];
  const preferredThoughts = preferredModel ? thoughtsOf(preferredModel) : [...FALLBACK_THOUGHTS];
  const preferredThought =
    catalog.defaultThought && preferredThoughts.includes(catalog.defaultThought)
      ? catalog.defaultThought
      : (preferredThoughts.includes("medium") ? "medium" : preferredThoughts[0]);
  return {
    revision,
    providers,
    ...(preferredModel
      ? {
          preferredSelection: {
            providerId: preferredModel.providerId,
            modelId: preferredModel.modelId,
            options: { reasoningLevel: preferredThought },
          },
        }
      : {}),
  } as unknown as ModelSelectionView;
}

export function publishPiModelCatalog(catalog: PiModelCatalogSnapshot): ModelSelectionView | null {
  if (catalog.models.length === 0) return current;
  revision += 1;
  snapshot = catalog;
  current = toPiModelSelectionView(catalog);
  changed.fire(current);
  return current;
}

export function getPiModelSelectionView(): ModelSelectionView | null {
  return current;
}

export function getPiModelCatalogSnapshot(): PiModelCatalogSnapshot | null {
  return snapshot;
}

export const onDidChangePiModelCatalog: Event<ModelSelectionView> = changed.event;

function withSelection(
  view: ModelSelectionView,
  input?: { selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } } | null },
): ModelSelectionView {
  if (!input) return view;
  const selection = input.selection;
  if (!selection) {
    return { ...view, effectiveSelection: null, selectionIssue: "selection-missing" };
  }
  const model = view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) {
    return { ...view, effectiveSelection: null, selectionIssue: "model-not-found" };
  }
  const values = model.config.optionSpecs.reasoningLevel.values;
  const reasoningLevel = selection.options?.reasoningLevel;
  const options =
    reasoningLevel && values.includes(reasoningLevel) ? { reasoningLevel } : undefined;
  return {
    ...view,
    effectiveSelection: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(options ? { options } : {}),
    },
  };
}

export function overlayPiModelSelectionService(
  base: IModelSelectionService,
): IModelSelectionService {
  const getView: IModelSelectionService["getView"] = async (input) => {
    const pi = getPiModelSelectionView();
    return pi ? withSelection(pi, input) : base.getView(input);
  };
  return {
    getView,
    onDidChange: (listener) => {
      const fromBase = base.onDidChange(() => {
        void getView().then(listener, () => undefined);
      });
      const fromPi = onDidChangePiModelCatalog((view) => listener(withSelection(view)));
      return {
        dispose() {
          fromBase.dispose();
          fromPi.dispose();
        },
      };
    },
  };
}
