import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TODO_TAGS, normalizeTodoTags, splitTodoTagDraft } from "./todo-types.js";

test("tag draft splits on comma and folds case duplicates", () => {
  assert.deepEqual(splitTodoTagDraft(" Bug, bug， Feature "), ["Bug", "bug", "Feature"]);
  assert.deepEqual(normalizeTodoTags(splitTodoTagDraft(" Bug, bug， Feature ")), [
    "Bug",
    "Feature",
  ]);
  assert.deepEqual(splitTodoTagDraft("  , ， "), []);
  assert.equal(MAX_TODO_TAGS, 8);
  assert.throws(() =>
    normalizeTodoTags(Array.from({ length: MAX_TODO_TAGS + 1 }, (_, index) => `t${index}`)),
  );
});
