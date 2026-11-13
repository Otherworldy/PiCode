import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeTaskService } from "@picode/services";
import type { ZCodeTaskMeta } from "@picode/shared";
import { windowHostControllerTaskRowSchema } from "@picode/shared/picode-protocol-v4";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { createWindowHostControllerProjection } from "./windowHostControllerProjection.js";

const scope = { kind: "local" as const, workspacePath: "/workspace" };
const original = {
  taskId: "session-title",
  traceId: "trace-title",
  title: "Original request",
  titleOverridden: true,
  workspacePath: scope.workspacePath,
  createdAt: 1,
  updatedAt: 10,
  mode: "build" as const,
};

test("Controller retains committed titles across continuous overlay and replayed snapshots", () => {
  const projection = createWindowHostControllerProjection({ createId: () => "title-test" });
  projection.registerSource({ scope, mutate: () => {} });
  const customOverlay = {
    taskId: original.taskId,
    title: original.title,
    titleSource: "custom" as const,
    updatedAt: 300,
    liveStatus: "running" as const,
    activity: { phase: "running" as const, lastActivityAt: 300, hasBackgroundWork: false },
  };
  const taskIndex = [
    {
      meta: { ...original, title: "Summarized title", titleRevision: 1, updatedAt: 200 },
      membership: { pinned: false, archived: false, active: true },
    },
  ];
  projection.replaceSourceSnapshot({ scope, taskIndex, sessionsIndex: [customOverlay] });
  assert.equal(projection.getTasks()[0]?.meta.title, "Summarized title");
  projection.replaceSourceSessionOverlays(scope, [{ ...customOverlay, updatedAt: 400 }]);
  const continuous = projection.getTasks()[0];
  assert.equal(continuous?.meta.title, "Summarized title");
  assert.equal(continuous?.meta.updatedAt, 400);
  assert.equal(continuous?.liveStatus, "running");
  const replayed = windowHostControllerTaskRowSchema.parse(JSON.parse(JSON.stringify(continuous)));
  assert.equal(replayed.meta.titleRevision, 1);
  projection.replaceSourceSnapshot({
    scope,
    taskIndex: [
      {
        ...taskIndex[0]!,
        meta: { ...taskIndex[0]!.meta, title: "Renamed again", titleRevision: 2 },
      },
    ],
    sessionsIndex: [customOverlay],
  });
  assert.equal(projection.getTasks()[0]?.meta.title, "Renamed again");
});

test(
  "Controller parallel partitions keep the newest title when an old partition resolves last",
  { timeout: 3_000 },
  async (t) => {
    for (const kind of ["pinned", "archived"] as const) {
      const newer = { ...original, title: "Renamed again", titleRevision: 2, updatedAt: 200 };
      const older = { ...original, titleRevision: 1 };
      let finishLate!: (tasks: ZCodeTaskMeta[]) => void;
      const latePartition = new Promise<ZCodeTaskMeta[]>((resolve) => {
        finishLate = resolve;
      });
      let activeRead!: () => void;
      const activeReadStarted = new Promise<void>((resolve) => {
        activeRead = resolve;
      });
      const taskService = {
        listTasks: async () => {
          activeRead();
          return [newer];
        },
        listPinnedTasks: () => (kind === "pinned" ? latePartition : Promise.resolve([])),
        listArchivedTasks: () => (kind === "archived" ? latePartition : Promise.resolve([])),
      } as unknown as IZCodeTaskService;
      const runtime = createWindowHostControllerRuntime({
        createId: () => `partition-title-${kind}`,
        resolveSource: () => ({ scope, taskService, sourceAvailability: "online" }),
      });
      t.after(() => runtime.dispose());
      const result = runtime.service.listTaskList({
        kind,
        sortBy: "updated",
        workspaceScopes: [{ workspacePath: scope.workspacePath }],
      });
      await activeReadStarted;
      finishLate([older]);
      const { items } = await result;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.title, newer.title);
      assert.equal(items[0]?.titleRevision, 2);
      assert.equal(items[0]?.titleOverridden, true);
      assert.equal(items[0]?.updatedAt, older.updatedAt);
    }
  },
);

test("Controller search compares title revisions with cached projection without losing snippets", async (t) => {
  const older = { ...original, titleRevision: 1 };
  const newer = { ...original, title: "New summary", titleRevision: 2, updatedAt: 200 };
  for (const [indexed, found] of [
    [older, newer],
    [newer, older],
  ] as const) {
    const taskService = {
      listTasks: async () => [indexed],
      listPinnedTasks: async () => [],
      listArchivedTasks: async () => [],
      listTaskList: async () => ({
        items: [{ ...found, searchSnippets: ["body match"] }],
        total: 1,
        hasMore: false,
      }),
    } as unknown as IZCodeTaskService;
    const runtime = createWindowHostControllerRuntime({
      createId: () => "search-title",
      resolveSource: () => ({ scope, taskService, sourceAvailability: "online" }),
    });
    t.after(() => runtime.dispose());
    const { items } = await runtime.service.listTaskList({
      kind: "active",
      sortBy: "updated",
      search: "body",
      workspaceScopes: [{ workspacePath: scope.workspacePath }],
    });
    assert.equal(items[0]?.title, newer.title);
    assert.equal(items[0]?.titleRevision, 2);
    assert.equal(items[0]?.updatedAt, indexed.updatedAt);
    assert.deepEqual(items[0]?.searchSnippets, ["body match"]);
  }
});

test("Controller still accepts legacy custom session names and generated titles", () => {
  const projection = createWindowHostControllerProjection({ createId: () => "legacy-title" });
  projection.registerSource({ scope, mutate: () => {} });
  projection.replaceSourceSnapshot({
    scope,
    taskIndex: [{ meta: original, membership: { pinned: false, archived: false, active: true } }],
    sessionsIndex: [
      { taskId: original.taskId, title: "CLI name", titleSource: "custom", liveStatus: "idle" },
    ],
  });
  assert.equal(projection.getTasks()[0]?.meta.title, "CLI name");
});
