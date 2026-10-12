import assert from "node:assert/strict";
import test from "node:test";
import { toPiModelSelectionView } from "../src/zcode-agent/piModelCatalog.js";

test("目录模型的 contextWindow 进入选择视图，供圆环在提交前读取", () => {
  const view = toPiModelSelectionView({
    models: [
      {
        providerId: "zai",
        modelId: "glm-long",
        contextWindow: 1_000_000.8,
        thoughtLevels: ["low"],
      },
    ],
    defaultProvider: "zai",
    defaultModel: "glm-long",
  });
  const model = view.providers[0]?.models[0];
  assert.equal(model?.modelId, "glm-long");
  assert.equal(model?.config.properties.contextWindow, 1_000_000);
});
