import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposerContextCapacity } from "../src/v4/composer/contextCapacity.js";

const providers = [
  {
    providerId: "zai",
    models: [
      { modelId: "glm-default", config: { properties: { contextWindow: 128_000 } } },
      { modelId: "glm-long", config: { properties: { contextWindow: 1_000_000 } } },
    ],
  },
];

test("切换模型后圆环总量用所选模型，不再停在快照里的默认容量", () => {
  assert.equal(
    resolveComposerContextCapacity({
      providers,
      providerId: "zai",
      modelId: "glm-long",
      snapshotMaxTokens: 128_000,
    }),
    1_000_000,
  );
});

test("目录还没有窗口时回落会话快照", () => {
  assert.equal(
    resolveComposerContextCapacity({
      providers,
      providerId: "zai",
      modelId: "missing",
      snapshotMaxTokens: 128_000,
    }),
    128_000,
  );
});

test("未选模型时不用别的模型窗口冒充总量", () => {
  assert.equal(
    resolveComposerContextCapacity({
      providers,
      snapshotMaxTokens: 128_000,
    }),
    128_000,
  );
  assert.equal(resolveComposerContextCapacity({ providers }), null);
});
