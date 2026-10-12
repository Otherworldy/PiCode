import assert from "node:assert/strict";
import test from "node:test";
import { shouldIncludeUntrackedChange } from "../src/git/repo/gitCliHelpers.js";

test("untracked empty files stay out, but content without line stats stays in", () => {
  assert.equal(
    shouldIncludeUntrackedChange({ path: "empty.txt" }, { added: 0, removed: 0 }),
    false,
  );
  assert.equal(
    shouldIncludeUntrackedChange({ path: "image.png" }, { added: 0, removed: 0, hasContent: true }),
    true,
  );
  assert.equal(shouldIncludeUntrackedChange({ path: "notes.md" }, { added: 3, removed: 0 }), true);
  assert.equal(shouldIncludeUntrackedChange({ path: "dist/" }, { added: 0, removed: 0 }), true);
});
