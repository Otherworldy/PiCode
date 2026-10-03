import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { deriveTaskLeadingIndicator } from "./taskListItemPresentation.js";

const task = {
  taskId: "s",
  traceId: "t",
  title: "t",
  workspacePath: "/w",
  createdAt: 1,
  updatedAt: 1,
  mode: "build",
  status: "completed",
  unreadAt: 5,
} as ZCodeTaskMeta;

const completed = {
  phase: "completedSuccess" as const,
  lastActivityAt: 1,
  hasBackgroundWork: false,
};

test("open session phase running shows the spinner even when the index is idle", () => {
  assert.equal(deriveTaskLeadingIndicator(task, completed, "running"), "loading");
  assert.equal(deriveTaskLeadingIndicator(task, null, "prewarming"), "loading");
});

test("without a live phase, unread still beats a stale running index", () => {
  assert.equal(
    deriveTaskLeadingIndicator(task, { ...completed, phase: "running" }, null),
    "unread",
  );
});

test("live completed does not keep a stale index spinner", () => {
  const quiet = { ...task, unreadAt: undefined };
  assert.equal(
    deriveTaskLeadingIndicator(quiet, { ...completed, phase: "running" }, "completedSuccess"),
    "none",
  );
});
