import assert from "node:assert/strict";
import test from "node:test";
import { lowestPiThought, piAssistantText } from "./pi-assistant-text.js";

test("lowest thought skips null levels", () => {
  assert.equal(lowestPiThought({ thinkingLevelMap: { off: null, high: "high" } }), "high");
  assert.equal(lowestPiThought({}), "off");
});

test("assistant text prefers answer over thinking", () => {
  assert.equal(
    piAssistantText({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "draft" },
        { type: "text", text: "feat: fix commit message" },
      ],
    }),
    "feat: fix commit message",
  );
});

test("assistant text falls back to thinking and rejects errors", () => {
  assert.equal(
    piAssistantText({
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "feat: only thinking" }],
    }),
    "feat: only thinking",
  );
  assert.throws(
    () => piAssistantText({ stopReason: "error", errorMessage: "no key", content: [] }),
    /no key/,
  );
});
