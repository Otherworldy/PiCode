import assert from "node:assert/strict";
import test from "node:test";
import { workspaceTaskListInvalidatedEventSchema } from "./task-realtime-core.js";

const event = {
  type: "workspace_task_list_invalidated",
  eventId: "title-event",
  workspacePath: "/workspace",
  workspaceKey: "/workspace",
  traceId: "title-trace",
  createdAt: 10,
  reason: "task_title_changed",
  taskId: "session-title",
  taskMeta: {
    taskId: "session-title",
    traceId: "title-trace",
    title: "总结标题",
    titleOverridden: true,
    titleRevision: 2,
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 10,
    mode: "build",
  },
};

test("replayable title invalidations retain the committed revision", () => {
  const parsed = workspaceTaskListInvalidatedEventSchema.parse(JSON.parse(JSON.stringify(event)));
  assert.equal(parsed.taskMeta?.title, event.taskMeta.title);
  assert.equal(parsed.taskMeta?.titleRevision, 2);
});

test("realtime title revisions accept legacy data and reject invalid versions", () => {
  assert.equal(
    workspaceTaskListInvalidatedEventSchema.safeParse({
      ...event,
      taskMeta: { ...event.taskMeta, titleRevision: undefined },
    }).success,
    true,
  );
  for (const titleRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    assert.equal(
      workspaceTaskListInvalidatedEventSchema.safeParse({
        ...event,
        taskMeta: { ...event.taskMeta, titleRevision },
      }).success,
      false,
    );
  }
});
