import assert from "node:assert/strict";
import test from "node:test";
import { compactFailureText } from "./compactFailureText.ts";

const format = (id: string) => id;

test("known compact refusals use product copy", () => {
  assert.equal(
    compactFailureText("Compaction failed: Nothing to compact (session too small)", format),
    "chat.contextCompaction.tooSmall",
  );
  assert.equal(
    compactFailureText("Already compacted", format),
    "chat.contextCompaction.alreadyCompacted",
  );
});

test("model failures stay visible", () => {
  assert.equal(compactFailureText("Compaction failed: 401 invalid api key", format), "401 invalid api key");
});
