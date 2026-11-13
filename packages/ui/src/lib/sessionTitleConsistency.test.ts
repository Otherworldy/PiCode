import assert from "node:assert/strict";
import test from "node:test";
import { resolveVersionedTaskTitle, type ZCodeTaskMeta } from "@picode/shared";
import { mergeTaskWithOptimisticMeta } from "./picodeTaskMetaMerge.js";
import { buildTaskEntityKey, type TaskListCacheDescriptor } from "./taskQueryCache.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "./taskListRefreshPolicy.js";
import { useTaskQueryCacheStore } from "../store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "../store/picodeSessionStore.js";
import {
  isSessionTitleSummarizing,
  requestSessionTitleSummary,
  sessionTitleSummaryKey,
  subscribeSessionTitleSummary,
} from "../sessionTitleSummaryPending.js";
import type { IZCodeTaskService } from "@picode/services";
import {
  buildTaskListResult,
  mergeTaskIndexRowsWithSessions,
} from "../v4/buildTaskListResultFromSessions.js";
import {
  fetchTaskListMembershipSets,
  fetchTaskListMembershipSetsForEndpointsCached,
} from "./taskListMembershipSets.js";
import { mapSessionSummaryToTaskMeta } from "../v4/mapSessionSummaryToTaskMeta.js";
import {
  attachTaskListRowActivity,
  getTaskListRowActivity,
  mergeTaskListMembershipFields,
} from "../v4/taskListRowActivity.js";

const original: ZCodeTaskMeta = {
  taskId: "session-title",
  traceId: "trace-title",
  title: "Original request with more characters",
  titleOverridden: true,
  workspacePath: "/workspace",
  createdAt: 1,
  updatedAt: 100,
  mode: "build",
};
const summarized = { ...original, title: "总结标题", titleRevision: 1, updatedAt: 200 };
const descriptor: TaskListCacheDescriptor = {
  kind: "workspace",
  sortBy: "updated",
  search: "",
  expanded: true,
  visibleLimit: null,
  workspaceKeys: [original.workspacePath],
};

function publish(task: ZCodeTaskMeta, search = "") {
  useTaskQueryCacheStore.getState().setQueryResult({
    queryKey: `title-test-${search}`,
    descriptor: { ...descriptor, search },
    items: [task],
    total: 1,
    hasMore: false,
  });
}

function cached(task: ZCodeTaskMeta = original) {
  return useTaskQueryCacheStore.getState().taskMetaByEntityKey[buildTaskEntityKey(task)];
}

test("old custom session activity cannot replace a committed summary", () => {
  const session = attachTaskListRowActivity(
    { ...original, updatedAt: 300, status: "running" },
    { phase: "running", lastActivityAt: 300, hasBackgroundWork: false },
  );
  const [joined] = mergeTaskIndexRowsWithSessions({
    taskIndexItems: [summarized],
    sessions: [session],
  });
  assert.equal(joined?.title, summarized.title);
  assert.equal(joined?.titleRevision, 1);
  assert.equal(joined?.updatedAt, 300);
  assert.equal(joined?.status, "running");
  assert.equal(joined && getTaskListRowActivity(joined)?.phase, "running");
  assert.equal(mergeTaskWithOptimisticMeta(session, summarized).title, summarized.title);
});

test("summary mapping keeps the confirmed title version while updating live details", () => {
  const mapped = mapSessionSummaryToTaskMeta(
    {
      sessionId: original.taskId,
      workspaceId: original.workspacePath,
      title: original.title,
      titleSource: "custom",
      phase: "running",
      sessionEnded: false,
      hasBackgroundWork: false,
      lastActivityAt: 300,
      createdAt: 1,
    },
    { workspacePath: original.workspacePath, previous: summarized },
  );
  assert.equal(mapped.title, summarized.title);
  assert.equal(mapped.titleRevision, 1);
  assert.equal(mapped.updatedAt, 300);
  assert.equal(mapped.status, "running");
});

test("same-version query publication and late membership response retain the summary", () => {
  const store = useTaskQueryCacheStore.getState();
  store.clearAll();
  try {
    publish(original);
    store.updateTaskMetaPreservingMembership(summarized);
    publish({ ...original, updatedAt: 400 });
    assert.equal(cached()?.title, summarized.title);
    assert.equal(cached()?.titleRevision, 1);
    store.applyTaskMutation({
      previousTask: original,
      nextTask: { ...original, updatedAt: 500 },
      previousState: { pinned: false, archived: false },
      nextState: { pinned: true, archived: false },
    });
    assert.equal(cached()?.title, summarized.title);
    assert.equal(cached()?.titleRevision, 1);
    assert.deepEqual(
      useTaskQueryCacheStore.getState().resultsByQueryKey["title-test-"]?.taskKeys,
      [],
    );
    publish({ ...summarized, title: "Later rename", titleRevision: 2, updatedAt: 150 });
    assert.equal(cached()?.title, "Later rename");
    assert.equal(cached()?.titleRevision, 2);
    publish({ ...summarized, updatedAt: 900 });
    assert.equal(cached()?.title, "Later rename");
    assert.equal(cached()?.titleRevision, 2);
  } finally {
    store.clearAll();
  }
});

test("stale search results keep the committed title without dropping snippets", () => {
  const store = useTaskQueryCacheStore.getState();
  store.clearAll();
  try {
    store.updateTaskMetaPreservingMembership(summarized);
    store.setQueryResult({
      queryKey: "title-search",
      descriptor: { ...descriptor, search: "request" },
      items: [{ ...original, searchSnippet: "body match" }],
      total: 1,
      hasMore: false,
    });
    assert.equal(cached()?.title, summarized.title);
    assert.equal(cached()?.searchSnippet, "body match");
  } finally {
    store.clearAll();
  }
});

test("late pin response preserves title, live phase, cleared interaction and unread update", () => {
  const activity = attachTaskListRowActivity(
    { ...summarized, status: "running" },
    { phase: "running", lastActivityAt: 300, hasBackgroundWork: false },
  );
  const merged = mergeTaskListMembershipFields(activity, {
    ...original,
    updatedAt: 500,
    status: "completed",
    unreadAt: 40,
    pendingInteraction: { interactionId: "old-question", kind: "userInput" },
  });
  assert.equal(merged.title, summarized.title);
  assert.equal(merged.titleRevision, 1);
  assert.equal(merged.updatedAt, 300);
  assert.equal(merged.status, "running");
  assert.equal(merged.pendingInteraction, undefined);
  assert.equal(merged.unreadAt, 40);
});

test("legacy generated titles still advance and remote identities stay separate", () => {
  const generated = { ...original, titleOverridden: false, title: "Generated title" };
  const [joined] = mergeTaskIndexRowsWithSessions({
    taskIndexItems: [{ ...original, titleOverridden: false }],
    sessions: [generated],
  });
  assert.equal(joined?.title, generated.title);
  const store = useTaskQueryCacheStore.getState();
  store.clearAll();
  try {
    publish({ ...summarized, workspaceIdentity: "remote:first" });
    publish({ ...original, workspaceIdentity: "remote:second" });
    assert.equal(
      cached({ ...original, workspaceIdentity: "remote:first" })?.title,
      summarized.title,
    );
    assert.equal(
      cached({ ...original, workspaceIdentity: "remote:second" })?.title,
      original.title,
    );
    publish({ ...original, titleOverridden: false });
    publish(generated);
    assert.equal(cached()?.title, generated.title);
  } finally {
    store.clearAll();
  }
});

test(
  "summary completion survives list refresh, optimistic cleanup and reopening",
  { timeout: 3_000 },
  async () => {
    const store = useTaskQueryCacheStore.getState();
    store.clearAll();
    publish(original);
    let finish!: (meta: ZCodeTaskMeta) => void;
    const result = new Promise<ZCodeTaskMeta>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const service = {
      summarizeTaskTitle: () => {
        calls += 1;
        return result;
      },
    } as Pick<IZCodeTaskService, "summarizeTaskTitle"> as IZCodeTaskService;
    const key = sessionTitleSummaryKey(original);
    let unsubscribe = () => {};
    const settled = new Promise<void>((resolve) => {
      unsubscribe = subscribeSessionTitleSummary(() => {
        if (!isSessionTitleSummarizing(key)) resolve();
      });
    });
    const errors: string[] = [];
    try {
      const request = {
        service,
        task: original,
        onError: () => {
          errors.push("failed");
        },
      };
      requestSessionTitleSummary(request);
      requestSessionTitleSummary(request);
      assert.equal(calls, 1);
      assert.equal(isSessionTitleSummarizing(key), true);
      finish(summarized);
      await settled;
      assert.equal(cached()?.title, summarized.title);
      useZCodeSessionStore
        .getState()
        .removeOptimisticTaskListItem(original.workspacePath, original.taskId);
      publish({ ...original, updatedAt: 600 });
      assert.equal(cached()?.title, summarized.title);
      store.upsertTaskMeta({ ...original, updatedAt: 700 });
      assert.equal(cached()?.title, summarized.title);
      assert.deepEqual(errors, []);
    } finally {
      unsubscribe();
      useZCodeSessionStore
        .getState()
        .removeOptimisticTaskListItem(original.workspacePath, original.taskId);
      store.clearAll();
    }
  },
);

test("parallel membership partitions keep the highest title revision for duplicate rows", async () => {
  const older = { ...original, titleRevision: 1 };
  const newer = { ...summarized, titleRevision: 2 };
  for (const [active, pinned] of [
    [newer, older],
    [older, newer],
  ] as const) {
    const membership = await fetchTaskListMembershipSets({
      service: {
        listPinnedTaskIds: async () => [original.taskId],
        listArchivedTasks: async () => [],
        listTasks: async () => [active],
        listPinnedTasks: async () => [pinned],
      },
      scopes: [{ workspacePath: original.workspacePath }],
    });
    assert.equal(membership.taskIndexItems.length, 1);
    const [row] = buildTaskListResult({
      ...membership,
      sessions: [],
      kind: "pinned",
      sortBy: "updated",
    }).items;
    assert.equal(row?.title, summarized.title);
    assert.equal(row?.titleRevision, 2);
    assert.equal(row?.titleOverridden, true);
  }
});

test("endpoint unions compare duplicate task titles by revision", async () => {
  const membership = await fetchTaskListMembershipSetsForEndpointsCached({
    cacheKey: "title-endpoint-union",
    endpoints: [summarized, original].map((task) => ({
      service: {
        listPinnedTaskIds: async () => [],
        listArchivedTasks: async () => [],
        listTasks: async () => [task],
        listPinnedTasks: async () => [],
      },
      scopes: [{ workspacePath: task.workspacePath }],
    })),
  });
  assert.equal(membership.taskIndexItems.length, 1);
  assert.equal(membership.taskIndexItems[0]?.title, summarized.title);
  assert.equal(membership.taskIndexItems[0]?.titleRevision, 1);
});

test("legacy title maps cannot attach an old title to a positive revision", () => {
  const versioned = { ...summarized, titleOverridden: false };
  const build = (task: ZCodeTaskMeta) =>
    buildTaskListResult({
      taskIndexItems: [task],
      sessions: [],
      pinnedIds: new Set(),
      archivedIds: new Set(),
      titleOverrideByTaskId: new Map([[task.taskId, original.title]]),
      kind: "active",
      sortBy: "updated",
    }).items[0];
  assert.equal(build(versioned)?.title, versioned.title);
  assert.equal(build(versioned)?.titleRevision, 1);
  assert.equal(build(versioned)?.titleOverridden, false);
  assert.equal(build({ ...versioned, titleRevision: undefined })?.title, original.title);
});

test("equal positive title revisions keep the preferred candidate atomically", () => {
  const preferred = { ...summarized, titleOverridden: false };
  const fallback = { ...original, titleRevision: 1 };
  const resolved = resolveVersionedTaskTitle(preferred, fallback);
  assert.deepEqual(resolved, {
    title: preferred.title,
    titleOverridden: false,
    titleRevision: 1,
  });
  assert.equal(resolveVersionedTaskTitle(original, { ...original, titleRevision: 0 }), undefined);
});

test("title changes refresh task rows cached with membership", () => {
  assert.equal(
    shouldRefetchTaskListMembershipForWorkspaceEvent({ reason: "task_title_changed" }),
    true,
  );
  assert.equal(
    shouldRefetchTaskListMembershipForWorkspaceEvent({ reason: "task_model_changed" }),
    false,
  );
});
