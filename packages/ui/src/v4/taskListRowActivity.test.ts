import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity, mergeTaskListMembershipFields } from "./taskListRowActivity.js";

const base = {
  taskId: "s",
  traceId: "t",
  title: "问",
  workspacePath: "/w",
  createdAt: 1,
  updatedAt: 10,
  mode: "build",
} as ZCodeTaskMeta;

test("membership merge cannot restore a cleared waiting badge", () => {
  const activity = attachTaskListRowActivity(
    { ...base },
    { phase: "running", lastActivityAt: 10, hasBackgroundWork: false },
  );
  const stale = {
    ...base,
    updatedAt: 50,
    pendingInteraction: { interactionId: "q1", kind: "userInput" as const },
  };
  const merged = mergeTaskListMembershipFields(activity, stale);
  assert.equal(merged.pendingInteraction, undefined);
});
