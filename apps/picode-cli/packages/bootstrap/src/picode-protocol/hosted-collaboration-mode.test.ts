import assert from "node:assert/strict";
import test from "node:test";
import {
  permissionWithCollaborationMode,
  storedCollaborationMode,
} from "./hosted-collaboration-mode.js";

test("stored collaboration mode keeps yolo and drops auto", () => {
  assert.equal(storedCollaborationMode("yolo"), "yolo");
  assert.equal(storedCollaborationMode("build"), "build");
  assert.equal(storedCollaborationMode("auto"), undefined);
  assert.equal(storedCollaborationMode("full"), undefined);
});

test("permission update keeps existing rules when the mode changes", () => {
  assert.deepEqual(
    permissionWithCollaborationMode(
      { allow: [{ toolName: "bash" }], mode: "build" },
      "yolo",
    ),
    { allow: [{ toolName: "bash" }], mode: "yolo" },
  );
});
