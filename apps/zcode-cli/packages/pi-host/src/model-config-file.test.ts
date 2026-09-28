import assert from "node:assert/strict";
import test from "node:test";
import {
  alignProviderModelApi,
  deleteProvider,
  toPiModelConfigView,
  toRuntimeConfig,
  upsertProvider,
  type ModelsJsonFile,
} from "./model-config-file.js";

test("upsert keeps extra model fields and returns the api key", () => {
  const file: ModelsJsonFile = {
    providers: {
      lens: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: "secret-key",
        models: [
          {
            id: "glm-5.3-flash",
            name: "GLM",
            api: "anthropic-messages",
            thinkingLevelMap: { high: "high" },
            compat: { thinkingFormat: "zai" },
          },
        ],
      },
    },
  };
  const next = upsertProvider(file, {
    id: "lens",
    name: "lens",
    baseUrl: "https://example.test/v1",
    api: "openai-responses",
    models: [
      { id: "glm-5.3-flash" },
      { id: "new-model", name: "New" },
    ],
  });
  const glm = (next.providers?.lens?.models as Array<Record<string, unknown>> | undefined)?.[0];
  assert.ok(glm);
  assert.equal((glm.thinkingLevelMap as { high: string } | undefined)?.high, "high");
  assert.equal(glm.api, "openai-responses");
  assert.equal(next.providers?.lens?.api, "openai-responses");
  assert.equal(next.providers?.lens?.apiKey, "secret-key");
  const view = toPiModelConfigView(next);
  assert.equal(view.providers[0]?.hasApiKey, true);
  assert.equal(view.providers[0]?.apiKey, "secret-key");
  assert.equal(view.providers[0]?.models.length, 2);
});

test("delete removes a provider", () => {
  const next = deleteProvider(
    { providers: { a: { baseUrl: "https://a.test" }, b: { baseUrl: "https://b.test" } } },
    "a",
  );
  assert.deepEqual(Object.keys(next.providers ?? {}), ["b"]);
});

test("upsert writes per-model limits and keeps thinkingLevelMap values", () => {
  const next = upsertProvider(
    {
      providers: {
        lens: {
          baseUrl: "https://example.test/v1",
          api: "openai-completions",
          models: [
            {
              id: "glm-5.3-flash",
              thinkingLevelMap: { high: "enabled" },
              compat: { thinkingFormat: "zai" },
            },
          ],
        },
      },
    },
    {
      id: "lens",
      baseUrl: "https://example.test/v1",
      api: "openai-responses",
      models: [
        {
          id: "glm-5.3-flash",
          name: "fast",
          contextWindow: 1048576,
          maxTokens: 128000,
          thinkingLevels: ["low", "high"],
          defaultThinkingLevel: "high",
          input: ["text", "image"],
        },
      ],
    },
  );
  const glm = (next.providers?.lens?.models as Array<Record<string, unknown>> | undefined)?.[0];
  assert.ok(glm);
  assert.equal(glm.name, "fast");
  assert.equal(glm.contextWindow, 1048576);
  assert.equal(glm.maxTokens, 128000);
  assert.deepEqual(glm.thinkingLevelMap, { low: "low", high: "enabled" });
  assert.equal(glm.defaultThinkingLevel, "high");
  assert.deepEqual(glm.input, ["text", "image"]);
  assert.equal((glm.compat as { thinkingFormat: string }).thinkingFormat, "zai");
  const view = toPiModelConfigView(next);
  assert.deepEqual(view.providers[0]?.models[0]?.thinkingLevels, ["low", "high"]);
  assert.equal(view.providers[0]?.models[0]?.contextWindow, 1048576);
  assert.equal(glm.api, "openai-responses");
});

test("null thinkingLevelMap values are filtered from views and kept on upsert", () => {
  const file: ModelsJsonFile = {
    providers: {
      lens: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        models: [
          {
            id: "glm-5.3-flash",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "low",
              medium: null,
              high: "high",
              xhigh: null,
              max: "max",
            },
          },
        ],
      },
    },
  };
  // 读取视图：null 条目不算可用等级。
  const view = toPiModelConfigView(file);
  assert.deepEqual(view.providers[0]?.models[0]?.thinkingLevels, ["low", "high", "max"]);
  // runtime 同理。
  const runtime = toRuntimeConfig(file.providers?.lens ?? {});
  assert.deepEqual(runtime.models[0]?.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
  // 保存时 UI 只勾选非 null 等级，null 条目保留不被覆盖。
  const next = upsertProvider(file, {
    id: "lens",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    models: [{ id: "glm-5.3-flash", thinkingLevels: ["low", "high", "max"] }],
  });
  const glm = next.providers?.lens?.models as Array<Record<string, unknown>>;
  assert.deepEqual(glm[0]?.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("missing model api inherits the provider; an override is kept", () => {
  const file: ModelsJsonFile = {
    providers: {
      lens: {
        api: "openai-responses",
        models: [{ id: "plain" }, { id: "claude", api: "anthropic-messages" }],
      },
    },
  };
  const aligned = alignProviderModelApi(file);
  const models = aligned.file.providers?.lens?.models as Array<{ id: string; api?: string }>;
  assert.equal(aligned.changed, true);
  assert.equal(models[0]?.api, "openai-responses");
  assert.equal(models[1]?.api, "anthropic-messages");
  const runtime = toRuntimeConfig(file.providers?.lens ?? {});
  assert.equal(runtime.models[0]?.api, "openai-responses");
  assert.equal(runtime.models[1]?.api, "anthropic-messages");
  const saved = upsertProvider(
    { providers: {} },
    {
      id: "mix",
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      models: [{ id: "claude", api: "anthropic-messages" }, { id: "gpt" }],
    },
  );
  const mix = saved.providers?.mix?.models as Array<{ api?: string }>;
  assert.equal(mix[0]?.api, "anthropic-messages");
  assert.equal(mix[1]?.api, "openai-completions");
  const view = toPiModelConfigView(saved);
  assert.equal(view.providers[0]?.models[0]?.api, "anthropic-messages");
});
