import assert from "node:assert/strict";
import test from "node:test";
import { buildComposerTodo } from "./messageStreamTodoModel.js";

const widgets = [
  {
    key: "plannotator-progress",
    lines: ["☑ 画背景", "☐ 画自行车", "noise", "☐ 画鹈鹕"],
  },
];

test("show todos builds the plannotator checklist for the composer drawer", () => {
  assert.equal(buildComposerTodo(false, widgets), null);
  const shown = buildComposerTodo(true, widgets);
  assert.deepEqual(
    shown?.steps.map((step) => [step.title, step.status]),
    [
      ["画背景", "completed"],
      ["画自行车", "in_progress"],
      ["画鹈鹕", "pending"],
    ],
  );
  assert.equal(shown?.completedCount, 1);
  assert.equal(shown?.activeTitle, "画自行车");
  assert.equal(buildComposerTodo(true, []), null);
});
