import assert from "node:assert/strict";
import test from "node:test";
import { collaborationModeMismatch } from "./collaborationModeSync.js";

test("full access still shown after a restart must be pushed again", () => {
  assert.equal(collaborationModeMismatch("yolo", "build"), "yolo");
  assert.equal(collaborationModeMismatch("yolo", "yolo"), null);
  assert.equal(collaborationModeMismatch("yolo", undefined), null);
  assert.equal(collaborationModeMismatch("plan", "build"), null);
});
