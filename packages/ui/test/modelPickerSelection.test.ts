import assert from "node:assert/strict";
import test from "node:test";
import {
  PICKER_DEFAULT_CAP_COUNT,
  annotateDiscovered,
  chosenFromDiscovered,
  defaultSelectedIds,
} from "../src/settings/model-picker-selection.ts";

function offered(count: number, prefix = "model") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} ${index}`,
  }));
}

test("annotateDiscovered marks existing models and keeps their position", () => {
  const entries = annotateDiscovered(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    [{ id: "b" }],
  );

  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.alreadyAdded]),
    [
      ["a", false],
      ["b", true],
      ["c", false],
    ],
  );
});

test("annotateDiscovered drops duplicate ids returned by the endpoint", () => {
  const entries = annotateDiscovered(
    [
      { id: "a", name: "first" },
      { id: "a", name: "second" },
    ],
    [],
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, "first");
});

test("defaultSelectedIds selects everything up to the cap", () => {
  const entries = annotateDiscovered(offered(20), []);

  const result = defaultSelectedIds(entries);

  assert.equal(result.capped, false);
  assert.equal(result.ids.length, 20);
});

test("defaultSelectedIds caps a large endpoint list to a few models", () => {
  const entries = annotateDiscovered(offered(42), []);

  const result = defaultSelectedIds(entries);

  assert.equal(result.capped, true);
  assert.equal(result.ids.length, PICKER_DEFAULT_CAP_COUNT);
  assert.deepEqual(result.ids, ["model-0", "model-1", "model-2", "model-3", "model-4"]);
});

test("defaultSelectedIds ignores already added models", () => {
  const existing = offered(20);
  const entries = annotateDiscovered(offered(25), existing);

  const result = defaultSelectedIds(entries);

  assert.equal(result.capped, false);
  assert.equal(result.ids.length, 5);
  assert.ok(result.ids.every((id) => !existing.some((model) => model.id === id)));
});

test("chosenFromDiscovered maps only selected, addable models", () => {
  const entries = annotateDiscovered(
    [
      { id: "a", name: "a", contextWindow: 64_000, maxTokens: 4_096 },
      { id: "b", name: "B alias" },
      { id: "c", name: "c" },
    ],
    [{ id: "c" }],
  );

  const chosen = chosenFromDiscovered(entries, ["a", "b", "c"]);

  assert.deepEqual(
    chosen.map((model) => model.id),
    ["a", "b"],
  );
  assert.equal(chosen[0]?.contextWindow, 64_000);
  assert.equal(chosen[0]?.maxTokens, 4_096);
  assert.equal(chosen[1]?.name, "B alias");
  assert.deepEqual(chosen[1]?.input, ["text"]);
});

test("chosenFromDiscovered falls back to defaultChosen values for missing metadata", () => {
  const entries = annotateDiscovered([{ id: "plain", name: "plain" }], []);

  const [chosen] = chosenFromDiscovered(entries, ["plain"]);

  assert.equal(chosen?.contextWindow, 128_000);
  assert.equal(chosen?.maxTokens, 8192);
  assert.deepEqual(chosen?.thinkingLevels, ["off", "low", "medium", "high"]);
  assert.equal(chosen?.api, undefined);
});

test("chosenFromDiscovered returns nothing when the selection is empty", () => {
  const entries = annotateDiscovered(offered(3), []);

  assert.deepEqual(chosenFromDiscovered(entries, []), []);
});
