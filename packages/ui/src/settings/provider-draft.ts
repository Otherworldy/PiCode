import type { ZCodePiModelsMutateResult } from "@zcode/shared";

export const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export const SERVICE_PRESETS = [
  { value: "custom" },
  {
    value: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
  },
  {
    value: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
  },
  {
    value: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
  },
  {
    value: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
  },
  {
    value: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
  },
] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CONTEXT_PRESETS = [
  { label: "128k", value: 128_000 },
  { label: "200k", value: 200_000 },
  { label: "500k", value: 500_000 },
  { label: "1M", value: 1_048_576 },
] as const;
export const OUTPUT_PRESETS = [
  { label: "4k", value: 4096 },
  { label: "8k", value: 8192 },
  { label: "32k", value: 32_768 },
  { label: "64k", value: 64_000 },
] as const;

export type CatalogView = ZCodePiModelsMutateResult;
export type CatalogModel = CatalogView["providers"][number]["models"][number];
type OfferedModel = { id: string; name: string; contextWindow?: number; maxTokens?: number };

export type ProviderDraft = {
  existing: boolean;
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: CatalogModel[];
};

export type ModelPatch = Omit<Partial<CatalogModel>, "api"> & { api?: string | null };

export function emptyProviderDraft(): ProviderDraft {
  return {
    existing: false,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    models: [],
  };
}

export function slugProviderId(name: string, url: string): string {
  const fromName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (fromName) return fromName;
  try {
    const host = new URL(url).hostname.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    if (host) return host;
  } catch {
    // 名称非拉丁且 URL 非法时走时间戳 id。
  }
  return `custom-${Date.now().toString(36)}`;
}

export function defaultChosen(offered: OfferedModel): CatalogModel {
  return {
    id: offered.id,
    name: offered.name && offered.name !== offered.id ? offered.name : offered.id,
    contextWindow: offered.contextWindow ?? 128_000,
    maxTokens: offered.maxTokens ?? 8192,
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text"],
  };
}

export function applyModelPatch(model: CatalogModel, partial: ModelPatch): CatalogModel {
  const { api, ...restPartial } = partial;
  if (api === null) {
    const { api: _api, ...rest } = model;
    return { ...rest, ...restPartial };
  }
  return { ...model, ...restPartial, ...(api ? { api } : {}) };
}
