import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@picode/services";
import {
  deriveDraftModelFallback,
  isModelInView,
  resolveRepairedDraftModelSelection,
} from "./draftModelRepair.js";
import { createComposerSubmissionConfig } from "./composerSubmissionConfig.js";

function viewWith(
  models: Array<{ providerId: string; modelId: string; thoughtLevels?: string[] }>,
  preferred?: { providerId: string; modelId: string; reasoningLevel?: string },
  effectiveSelection?: { providerId: string; modelId: string; reasoningLevel?: string } | null,
): ModelSelectionView {
  return {
    revision: 1,
    providers: models.map((model) => ({
      providerId: model.providerId,
      config: {},
      models: [
        {
          modelId: model.modelId,
          config: {
            optionSpecs: {
              reasoningLevel: { values: model.thoughtLevels ?? ["low", "medium", "high"] },
            },
          },
        },
      ],
    })),
    ...(preferred
      ? {
          preferredSelection: {
            providerId: preferred.providerId,
            modelId: preferred.modelId,
            ...(preferred.reasoningLevel
              ? { options: { reasoningLevel: preferred.reasoningLevel } }
              : {}),
          },
        }
      : {}),
    ...(effectiveSelection === undefined
      ? {}
      : {
          effectiveSelection: effectiveSelection
            ? {
                providerId: effectiveSelection.providerId,
                modelId: effectiveSelection.modelId,
                ...(effectiveSelection.reasoningLevel
                  ? { options: { reasoningLevel: effectiveSelection.reasoningLevel } }
                  : {}),
              }
            : null,
        }),
  } as unknown as ModelSelectionView;
}

// 远端账号目录改名后的真实形态：记住的是 grok-4.7-free，目录里已是 free/grok-4.7。
const renamedCatalog = viewWith(
  [
    { providerId: "lens", modelId: "free/grok-4.7" },
    { providerId: "lens", modelId: "glm-5.3" },
  ],
  { providerId: "lens", modelId: "glm-5.3", reasoningLevel: "medium" },
);

function derive(
  view: ModelSelectionView | null,
  current:
    | { providerId: string; modelId: string; options?: { reasoningLevel: string } }
    | undefined,
  overrides: Partial<Parameters<typeof deriveDraftModelFallback>[0]> = {},
) {
  return deriveDraftModelFallback({
    view,
    current,
    draftInitialized: true,
    awaitingFirstImport: false,
    isNewTask: false,
    hasSessionConfig: true,
    sessionConfigSelection: undefined,
    ...overrides,
  });
}

test("a remembered model that is still in the catalog is kept", () => {
  assert.equal(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: {
        providerId: "lens",
        modelId: "free/grok-4.7",
        options: { reasoningLevel: "high" },
      },
      candidates: [{ providerId: "lens", modelId: "glm-5.3" }],
    }),
    null,
  );
});

test("a remembered model renamed upstream falls back to the first usable candidate", () => {
  assert.deepEqual(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: {
        providerId: "lens",
        modelId: "grok-4.7-free",
        options: { reasoningLevel: "high" },
      },
      candidates: [
        { providerId: "lens", modelId: "grok-4.7-free" },
        { providerId: "lens", modelId: "glm-5.3", options: { reasoningLevel: "medium" } },
      ],
    }),
    { providerId: "lens", modelId: "glm-5.3", options: { reasoningLevel: "medium" } },
  );
});

test("a missing selection is repaired from candidates", () => {
  assert.deepEqual(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: undefined,
      candidates: [undefined, { providerId: "lens", modelId: "glm-5.3" }],
    }),
    { providerId: "lens", modelId: "glm-5.3" },
  );
});

test("a candidate whose reasoning level is gone keeps only the model identity", () => {
  assert.deepEqual(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: { providerId: "lens", modelId: "gone" },
      candidates: [
        { providerId: "lens", modelId: "glm-5.3", options: { reasoningLevel: "xhigh" } },
      ],
    }),
    { providerId: "lens", modelId: "glm-5.3" },
  );
});

test("nothing usable leaves the remembered value untouched", () => {
  assert.equal(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: { providerId: "lens", modelId: "gone" },
      candidates: [{ providerId: "hub", modelId: "gone" }, undefined],
    }),
    null,
  );
});

test("the remembered value is never reused as its own repair", () => {
  assert.equal(
    resolveRepairedDraftModelSelection({
      view: renamedCatalog,
      current: { providerId: "lens", modelId: "gone" },
      candidates: [{ providerId: "lens", modelId: "gone" }],
    }),
    null,
  );
});

test("isModelInView matches model identity only", () => {
  assert.equal(isModelInView(renamedCatalog, { providerId: "lens", modelId: "glm-5.3" }), true);
  assert.equal(
    isModelInView(renamedCatalog, { providerId: "lens", modelId: "grok-4.7-free" }),
    false,
  );
  assert.equal(isModelInView(renamedCatalog, { providerId: "hub", modelId: "glm-5.3" }), false);
});

// ── 触发时机（时序守卫）────────────────────────────────

test("no derivation before the Host view exists", () => {
  assert.equal(derive(null, { providerId: "lens", modelId: "free/grok-4.7" }), null);
});

test("a selection the Host already resolved is never overridden", () => {
  // Host 会用 resolveEffectiveModelSelection 把 account-plan 改写到当前连接；已解析即视为有效。
  const resolved = viewWith(
    [{ providerId: "account:zai-individual-coding-plan", modelId: "glm-4.6" }],
    { providerId: "account:zai-individual-coding-plan", modelId: "glm-4.6" },
    { providerId: "account:zai-individual-coding-plan", modelId: "glm-4.6" },
  );
  assert.equal(
    derive(resolved, { providerId: "account:zai-team-coding-plan", modelId: "glm-4.6" }),
    null,
  );
});

test("an uninitialized draft and a first-import draft are left alone", () => {
  const current = { providerId: "lens", modelId: "grok-4.7-free" };
  assert.equal(derive(renamedCatalog, current, { draftInitialized: false }), null);
  assert.equal(derive(renamedCatalog, current, { awaitingFirstImport: true }), null);
});

test("an existing session waits for its snapshot instead of using the Host default", () => {
  const current = { providerId: "lens", modelId: "grok-4.7-free" };
  const lateSnapshot = derive(renamedCatalog, current, {
    isNewTask: false,
    hasSessionConfig: false,
    sessionConfigSelection: undefined,
  });
  assert.equal(lateSnapshot, null);
  // 快照到达后回退到会话真值，而不是 Host 默认。
  assert.deepEqual(
    derive(renamedCatalog, current, {
      sessionConfigSelection: { providerId: "lens", modelId: "free/grok-4.7" },
    }),
    { providerId: "lens", modelId: "free/grok-4.7" },
  );
});

test("a new task falls back to the Host default", () => {
  assert.deepEqual(
    derive(
      renamedCatalog,
      { providerId: "lens", modelId: "grok-4.7-free" },
      {
        isNewTask: true,
        hasSessionConfig: false,
      },
    ),
    { providerId: "lens", modelId: "glm-5.3", options: { reasoningLevel: "medium" } },
  );
});

test("a session whose truth is absent follows the Host default", () => {
  assert.deepEqual(derive(renamedCatalog, undefined, { sessionConfigSelection: undefined }), {
    providerId: "lens",
    modelId: "glm-5.3",
    options: { reasoningLevel: "medium" },
  });
});

test("derivation is idempotent and never writes the draft", () => {
  const current = { providerId: "lens", modelId: "grok-4.7-free" };
  const first = derive(renamedCatalog, current);
  assert.deepEqual(first, derive(renamedCatalog, current));
  // 草稿原意不被回退污染：同一个失效 id 在目录恢复后重新有效。
  assert.deepEqual(
    derive(
      viewWith([{ providerId: "lens", modelId: "grok-4.7-free" }], {
        providerId: "lens",
        modelId: "grok-4.7-free",
      }),
      current,
    ),
    null,
  );
});

// ── 与实际提交门禁的闭环 ───────────────────────────────

test("a derived fallback without a supported level still blocks submission", () => {
  const view = viewWith([{ providerId: "lens", modelId: "free/grok-4.7" }]);
  // 目录里没有 preferredSelection，会话真值带失效档位 → 回退只保留身份。
  const fallback = derive(
    view,
    { providerId: "lens", modelId: "gone" },
    {
      sessionConfigSelection: {
        providerId: "lens",
        modelId: "free/grok-4.7",
        options: { reasoningLevel: "xhigh" },
      },
    },
  );
  assert.deepEqual(fallback, { providerId: "lens", modelId: "free/grok-4.7" });
  assert.equal(createComposerSubmissionConfig({ modelSelection: fallback! }, view), null);
  // 档位受支持时可提交。
  const withLevel = derive(
    view,
    { providerId: "lens", modelId: "gone" },
    {
      sessionConfigSelection: {
        providerId: "lens",
        modelId: "free/grok-4.7",
        options: { reasoningLevel: "high" },
      },
    },
  );
  assert.notEqual(createComposerSubmissionConfig({ modelSelection: withLevel! }, view), null);
});
