import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodePiModelsMutateResult } from "@zcode/shared";

function flattenCatalogModels(view: ZCodePiModelsMutateResult | null) {
  return (
    view?.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        providerApi: provider.api,
        model,
      })),
    ) ?? []
  );
}

function resolveDefaultModelEntry(
  allModels: ReturnType<typeof flattenCatalogModels>,
  defaultProvider?: string,
  defaultModel?: string,
) {
  return (
    allModels.find(
      (entry) => entry.providerId === defaultProvider && entry.model.id === defaultModel,
    ) ?? null
  );
}

test("flattenCatalogModels extracts models from providers and identifies default", () => {
  const sampleView: ZCodePiModelsMutateResult = {
    providers: [
      {
        id: "lens",
        name: "Lens AI",
        baseUrl: "https://api.example.com",
        api: "openai-completions",
        hasApiKey: true,
        models: [
          {
            id: "glm-5",
            name: "GLM 5",
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: true,
            thinkingLevels: ["low", "medium", "high"],
            input: ["text"],
          },
        ],
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        hasApiKey: true,
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek V3",
            contextWindow: 64000,
            maxTokens: 8000,
            reasoning: false,
            thinkingLevels: [],
            input: ["text", "image"],
          },
        ],
      },
    ],
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    defaultThought: "high",
  };

  const flattened = flattenCatalogModels(sampleView);
  assert.equal(flattened.length, 2);
  assert.equal(flattened[0]?.model.id, "glm-5");
  assert.equal(flattened[1]?.model.id, "deepseek-chat");

  const resolvedDefault = resolveDefaultModelEntry(
    flattened,
    sampleView.defaultProvider,
    sampleView.defaultModel,
  );
  assert.ok(resolvedDefault);
  assert.equal(resolvedDefault.providerId, "deepseek");
  assert.equal(resolvedDefault.model.id, "deepseek-chat");
  assert.equal(resolvedDefault.model.input.includes("image"), true);
});

test("flattenCatalogModels handles null or empty catalog view", () => {
  assert.deepEqual(flattenCatalogModels(null), []);
  assert.deepEqual(
    flattenCatalogModels({ providers: [] }),
    [],
  );
});
