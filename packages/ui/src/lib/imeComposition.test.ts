import assert from "node:assert/strict";
import test from "node:test";
import { isImeComposingKeyEvent } from "./imeComposition.js";

test("plain Enter is not an IME confirm", () => {
  assert.equal(isImeComposingKeyEvent({ key: "Enter", keyCode: 13 }), false);
});

test("composition, Process, and Chromium keyCode 229 are IME", () => {
  assert.equal(isImeComposingKeyEvent({ key: "Enter", isComposing: true }), true);
  assert.equal(isImeComposingKeyEvent({ key: "Process" }), true);
  assert.equal(isImeComposingKeyEvent({ key: "Enter", nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isImeComposingKeyEvent({ key: "ArrowDown", compositionActive: true }), true);
});
