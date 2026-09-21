import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PiProviderModelDraft = { id: string; name?: string };

export type PiProviderDraft = {
  id: string;
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: PiProviderModelDraft[];
};

export type PiModelConfigView = {
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    api: string;
    hasApiKey: boolean;
    models: Array<{ id: string; name: string }>;
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
        const model = entry as { id?: unknown; name?: unknown };
        const modelId = typeof model.id === "string" ? model.id : "";
        if (!modelId) return [];
        return [
          {
            id: modelId,
            name: typeof model.name === "string" && model.name ? model.name : modelId,
          },
        ];
      }),
    };
  });
  return {
    providers,
    ...(defaults.defaultProvider ? { defaultProvider: defaults.defaultProvider } : {}),
    ...(defaults.defaultModel ? { defaultModel: defaults.defaultModel } : {}),
  };
}

function defaultModelRecord(
  draft: PiProviderModelDraft,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  if (existing) {
    return {
      ...existing,
      id: draft.id,
      ...(draft.name ? { name: draft.name } : {}),
    };
  }
  return {
    id: draft.id,
    name: draft.name ?? draft.id,
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { ...ZERO_COST },
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
  previous.models = draft.models.map((model) => defaultModelRecord(model, byId.get(model.id)));
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
    input: Array<"text" | "image">;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
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
      return [
        {
          id,
          name: typeof model.name === "string" && model.name ? model.name : id,
          reasoning: model.reasoning !== false,
          input: Array.isArray(model.input)
            ? (model.input.filter((item) => item === "text" || item === "image") as Array<
                "text" | "image"
              >)
            : ["text"],
          contextWindow:
            typeof model.contextWindow === "number" && model.contextWindow > 0
              ? model.contextWindow
              : 128000,
          maxTokens:
            typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : 8192,
          cost:
            model.cost && typeof model.cost === "object"
              ? {
                  input: Number((model.cost as { input?: unknown }).input) || 0,
                  output: Number((model.cost as { output?: unknown }).output) || 0,
                  cacheRead: Number((model.cost as { cacheRead?: unknown }).cacheRead) || 0,
                  cacheWrite: Number((model.cost as { cacheWrite?: unknown }).cacheWrite) || 0,
                }
              : { ...ZERO_COST },
        },
      ];
    }),
  };
}

export async function discoverPiModels(
  baseUrl: string,
  apiKey?: string,
): Promise<Array<{ id: string; name: string }>> {
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
    const id = String(
      (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name ?? "",
    ).trim();
    if (!id) return [];
    const name = String((entry as { name?: unknown }).name ?? id).trim() || id;
    return [{ id, name }];
  });
}
