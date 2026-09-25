import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

export type PiProviderModelDraft = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: string[];
  defaultThinkingLevel?: string;
  input?: Array<"text" | "image">;
};

export type PiProviderDraft = {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: PiProviderModelDraft[];
};

export type PiModelView = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels: string[];
  defaultThinkingLevel?: string;
  input: Array<"text" | "image">;
};

export type PiDiscoveredModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
};

export type PiModelConfigView = {
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    api: string;
    hasApiKey: boolean;
    models: PiModelView[];
  }>;
  defaultProvider?: string;
  defaultModel?: string;
};

export type ModelsJsonFile = {
  providers?: Record<string, Record<string, unknown>>;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function modelsJsonPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

export async function loadModelsJson(agentDir: string): Promise<ModelsJsonFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(modelsJsonPath(agentDir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ModelsJsonFile;
    }
  } catch {
    // 没有文件或坏 JSON 当成空目录，让设置页可以新建供应商。
  }
  return { providers: {} };
}

export async function saveModelsJson(agentDir: string, file: ModelsJsonFile): Promise<void> {
  const path = modelsJsonPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function toPiModelConfigView(
  file: ModelsJsonFile,
  defaults: { defaultProvider?: string; defaultModel?: string } = {},
): PiModelConfigView {
  const providers = Object.entries(file.providers ?? {}).map(([id, raw]) => {
    const models = Array.isArray(raw.models) ? raw.models : [];
    return {
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
      api: typeof raw.api === "string" && raw.api ? raw.api : "openai-completions",
      hasApiKey: typeof raw.apiKey === "string" && raw.apiKey.length > 0,
      models: models.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const model = toViewModel(entry as Record<string, unknown>);
        return model ? [model] : [];
      }),
    };
  });
  return {
    providers,
    ...(defaults.defaultProvider ? { defaultProvider: defaults.defaultProvider } : {}),
    ...(defaults.defaultModel ? { defaultModel: defaults.defaultModel } : {}),
  };
}

function asInput(value: unknown): Array<"text" | "image"> {
  const items = Array.isArray(value)
    ? value.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  return items.includes("text") ? items : ["text", ...items];
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function thinkingLevelsOf(model: Record<string, unknown>): string[] {
  const map = model.thinkingLevelMap;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const keys = Object.keys(map);
    if (keys.length > 0) return keys;
  }
  return model.reasoning === false ? ["off"] : [...DEFAULT_THINKING_LEVELS];
}

function thinkingLevelMapFrom(
  levels: string[] | undefined,
  existing: unknown,
): Record<string, string | null> {
  const prev =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const keys = levels ?? (Object.keys(prev).length > 0 ? Object.keys(prev) : [...DEFAULT_THINKING_LEVELS]);
  const next: Record<string, string | null> = {};
  for (const level of keys) {
    const value = prev[level];
    next[level] = typeof value === "string" || value === null ? value : level;
  }
  return next;
}

function toViewModel(model: Record<string, unknown>): PiModelView | undefined {
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return undefined;
  const thinkingLevels = thinkingLevelsOf(model);
  const defaultThinkingLevel =
    typeof model.defaultThinkingLevel === "string" && model.defaultThinkingLevel
      ? model.defaultThinkingLevel
      : undefined;
  return {
    id,
    name: typeof model.name === "string" && model.name ? model.name : id,
    contextWindow: positiveInt(model.contextWindow, 128000),
    maxTokens: positiveInt(model.maxTokens, 8192),
    reasoning: model.reasoning !== false,
    thinkingLevels,
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    input: asInput(model.input),
  };
}

function defaultModelRecord(
  draft: PiProviderModelDraft,
  existing: Record<string, unknown> | undefined,
  api: string,
): Record<string, unknown> {
  const thinkingLevelMap = thinkingLevelMapFrom(draft.thinkingLevels, existing?.thinkingLevelMap);
  const reasoning =
    draft.reasoning ??
    (draft.thinkingLevels
      ? draft.thinkingLevels.some((level) => level !== "off")
      : existing?.reasoning !== false);
  return {
    ...(existing ?? { cost: { ...ZERO_COST } }),
    id: draft.id,
    // 设置页只有渠道这一处格式。模型上残留的 api 会让 Pi 改走别的协议。
    api,
    name: draft.name ?? (typeof existing?.name === "string" && existing.name ? existing.name : draft.id),
    reasoning,
    thinkingLevelMap,
    input: draft.input ?? asInput(existing?.input),
    contextWindow: draft.contextWindow ?? positiveInt(existing?.contextWindow, 128000),
    maxTokens: draft.maxTokens ?? positiveInt(existing?.maxTokens, 8192),
    ...(draft.defaultThinkingLevel || typeof existing?.defaultThinkingLevel === "string"
      ? {
          defaultThinkingLevel:
            draft.defaultThinkingLevel ?? (existing?.defaultThinkingLevel as string),
        }
      : {}),
  };
}

export function upsertProvider(file: ModelsJsonFile, draft: PiProviderDraft): ModelsJsonFile {
  const providers = { ...(file.providers ?? {}) };
  const previous = { ...(providers[draft.id] ?? {}) };
  const previousModels = Array.isArray(previous.models) ? previous.models : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of previousModels) {
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      byId.set((entry as { id: string }).id, entry as Record<string, unknown>);
    }
  }
  previous.baseUrl = draft.baseUrl;
  previous.api = draft.api;
  if (draft.name?.trim()) previous.name = draft.name.trim();
  if (draft.apiKey) previous.apiKey = draft.apiKey;
  previous.models = draft.models.map((model) =>
    defaultModelRecord(model, byId.get(model.id), draft.api),
  );
  providers[draft.id] = previous;
  return { ...file, providers };
}

export function deleteProvider(file: ModelsJsonFile, providerId: string): ModelsJsonFile {
  const providers = { ...(file.providers ?? {}) };
  delete providers[providerId];
  return { ...file, providers };
}

export function storedApiKey(file: ModelsJsonFile, providerId: string): string | undefined {
  const value = file.providers?.[providerId]?.apiKey;
  return typeof value === "string" && value ? value : undefined;
}

export function toRuntimeConfig(raw: Record<string, unknown>): {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    input: Array<"text" | "image">;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    api?: string;
    compat?: unknown;
  }>;
} {
  const models = Array.isArray(raw.models) ? raw.models : [];
  return {
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
    ...(typeof raw.api === "string" ? { api: raw.api } : {}),
    ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
    models: models.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === "string" ? model.id : "";
      if (!id) return [];
      const thinkingLevelMap = thinkingLevelMapFrom(undefined, model.thinkingLevelMap);
      return [
        {
          id,
          name: typeof model.name === "string" && model.name ? model.name : id,
          reasoning: model.reasoning !== false,
          thinkingLevelMap,
          input: asInput(model.input),
          contextWindow: positiveInt(model.contextWindow, 128000),
          maxTokens: positiveInt(model.maxTokens, 8192),
          cost:
            model.cost && typeof model.cost === "object"
              ? {
                  input: Number((model.cost as { input?: unknown }).input) || 0,
                  output: Number((model.cost as { output?: unknown }).output) || 0,
                  cacheRead: Number((model.cost as { cacheRead?: unknown }).cacheRead) || 0,
                  cacheWrite: Number((model.cost as { cacheWrite?: unknown }).cacheWrite) || 0,
                }
              : { ...ZERO_COST },
          ...(typeof raw.api === "string" && raw.api
            ? { api: raw.api }
            : typeof model.api === "string"
              ? { api: model.api }
              : {}),
          ...(model.compat && typeof model.compat === "object" ? { compat: model.compat } : {}),
        },
      ];
    }),
  };
}

/** 渠道 api 是请求格式。模型项上不同的 api 改成渠道的，Pi 才不会改走别的协议。 */
export function alignProviderModelApi(file: ModelsJsonFile): { file: ModelsJsonFile; changed: boolean } {
  let changed = false;
  const providers: NonNullable<ModelsJsonFile["providers"]> = {};
  for (const [id, raw] of Object.entries(file.providers ?? {})) {
    const api = typeof raw.api === "string" ? raw.api : "";
    const models = Array.isArray(raw.models) ? raw.models : undefined;
    if (!api || !models) {
      providers[id] = raw;
      continue;
    }
    let modelsChanged = false;
    const nextModels = models.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const model = entry as Record<string, unknown>;
      if (model.api === api) return entry;
      modelsChanged = true;
      return { ...model, api };
    });
    if (!modelsChanged) {
      providers[id] = raw;
      continue;
    }
    changed = true;
    providers[id] = { ...raw, models: nextModels };
  }
  return { file: changed ? { ...file, providers } : file, changed };
}

export async function alignStoredModelApi(agentDir: string): Promise<void> {
  const file = await loadModelsJson(agentDir);
  const aligned = alignProviderModelApi(file);
  if (aligned.changed) await saveModelsJson(agentDir, aligned.file);
}

function optionalPositive(entry: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export async function discoverPiModels(
  baseUrl: string,
  apiKey?: string,
): Promise<PiDiscoveredModel[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${root}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`discover failed: ${response.status}`);
  }
  const payload: unknown = await response.json();
  const list = Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : Array.isArray(payload)
        ? payload
        : [];
  return list.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ id: entry.trim(), name: entry.trim() }];
    }
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? row.name ?? "").trim();
    if (!id) return [];
    const name = String(row.name ?? id).trim() || id;
    const contextWindow = optionalPositive(row, [
      "context_window",
      "contextWindow",
      "context_length",
      "max_model_len",
    ]);
    const maxTokens = optionalPositive(row, ["max_output_tokens", "maxTokens", "max_tokens"]);
    return [
      {
        id,
        name,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      },
    ];
  });
}
