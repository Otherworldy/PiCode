import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteProvider,
  toPiModelConfigView,
  upsertProvider,
  type ModelsJsonFile,
} from "./model-config-file.js";

test("upsert keeps extra model fields and masks api keys in the view", () => {
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
  assert.equal(next.providers?.lens?.api, "openai-responses");
  assert.equal(next.providers?.lens?.apiKey, "secret-key");
  const view = toPiModelConfigView(next);
  assert.equal(view.providers[0]?.hasApiKey, true);
  assert.equal(JSON.stringify(view).includes("secret-key"), false);
  assert.equal(view.providers[0]?.models.length, 2);
});

test("delete removes a provider", () => {
  const next = deleteProvider(
    { providers: { a: { baseUrl: "https://a.test" }, b: { baseUrl: "https://b.test" } } },
    "a",
  );
  assert.deepEqual(Object.keys(next.providers ?? {}), ["b"]);
});
