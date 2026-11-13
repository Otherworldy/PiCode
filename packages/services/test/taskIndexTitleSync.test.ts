import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  zcodeTaskMetaSchema,
  type ZCodeTaskMeta,
} from "@picode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

async function tempDir(): Promise<string> {
  const root = tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "zcode-title-sync-"));
}

async function fixture(t: TestContext): Promise<{ repo: TaskIndexRepo; dbPath: string }> {
  const dir = await tempDir();
  const dbPath = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  t.after(async () => {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { repo, dbPath };
}

function meta(title: string, updatedAt: number): ZCodeTaskMeta {
  return {
    taskId: "task-title",
    traceId: "trace-title" as ZCodeTaskMeta["traceId"],
    workspacePath: "/example/workspace",
    title,
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt,
  };
}

test("snapshot sync does not replace a summarized title with the first message", async () => {
  const dir = await tempDir();
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({ meta: meta("修登录", 10) });
    await repo.syncTaskMeta({ meta: meta("帮我看一下登录页为什么失败", 11) });
    const [row] = await repo.listTaskMetas({ workspacePath: "/example/workspace" });
    assert.equal(row?.title, "修登录");
    const patched = await repo.applyAgentPatch({
      workspacePath: "/example/workspace",
      taskId: "task-title",
      patch: { title: "新的总结" },
    });
    assert.equal(patched?.title, "新的总结");
    repo.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot sync still replaces a placeholder title", async () => {
  const dir = await tempDir();
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({ meta: meta("New session", 10) });
    await repo.syncTaskMeta({ meta: meta("修登录", 11) });
    const [row] = await repo.listTaskMetas({ workspacePath: "/example/workspace" });
    assert.equal(row?.title, "修登录");
    repo.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const taskRef = { workspacePath: "/example/workspace", taskId: "task-title" };

async function rename(repo: TaskIndexRepo, title: string): Promise<ZCodeTaskMeta> {
  return repo.updateTaskState({ ...taskRef, patch: { title, titleOverridden: true } });
}

test("titleRevision validates optional nonnegative safe integers without stripping them", () => {
  for (const titleRevision of [undefined, 0, 1, Number.MAX_SAFE_INTEGER]) {
    const parsed = zcodeTaskMetaSchema.parse({ ...meta("title", 10), titleRevision });
    assert.equal(parsed.titleRevision, titleRevision);
  }
  for (const titleRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"]) {
    assert.equal(
      zcodeTaskMetaSchema.safeParse({ ...meta("title", 10), titleRevision }).success,
      false,
    );
  }
});

test("explicit renames allocate monotonic revisions and repeating a committed title is idempotent", async (t) => {
  const { repo } = await fixture(t);
  await repo.syncTaskMeta({ meta: meta("initial", 10) });
  const first = await rename(repo, "first");
  assert.equal(first.titleRevision, 1);
  assert.equal(first.titleOverridden, true);
  assert.equal((await rename(repo, "first")).titleRevision, 1);
  const second = await rename(repo, "second");
  assert.equal(second.titleRevision, 2);
  assert.equal((await rename(repo, "first")).titleRevision, 3);
});

test("first explicit confirmation versions unchanged legacy and automatic titles", async (t) => {
  const { repo } = await fixture(t);
  await repo.syncTaskMeta({ meta: meta("initial", 10) });
  assert.equal((await rename(repo, "initial")).titleRevision, 1);
  const legacy = {
    ...meta("legacy", 10),
    taskId: "legacy",
    titleOverridden: true,
    titleRevision: 0,
  };
  await repo.seedTaskMetaIfMissing(legacy);
  const confirmed = await repo.updateTaskState({
    ...legacy,
    patch: { title: "legacy", titleOverridden: true },
  });
  assert.equal(confirmed.titleRevision, 1);
  await repo.updateTaskState({ ...taskRef, patch: { titleOverridden: false } });
  const automatic = await repo.updateTaskState({ ...taskRef, patch: { title: "automatic" } });
  assert.equal(automatic.titleRevision, 1);
  assert.equal((await rename(repo, "automatic")).titleRevision, 2);
});

test("stale snapshots, agent titles, status, pin, archive, unread and baseline seeds preserve confirmed revision", async (t) => {
  const { repo } = await fixture(t);
  await repo.syncTaskMeta({ meta: meta("initial", 10) });
  await rename(repo, "summary");
  const snapshot = await repo.syncTaskMeta({
    meta: { ...meta("stale", 1000), titleRevision: 999, status: "running" },
  });
  assert.equal(snapshot.title, "summary");
  assert.equal(snapshot.titleRevision, 1);
  assert.equal(snapshot.titleOverridden, true);
  assert.equal(snapshot.updatedAt, 1000);
  assert.equal(snapshot.status, "running");
  const agent = await repo.applyAgentPatch({
    ...taskRef,
    patch: { title: "agent title", status: "completed", updatedAt: 1001 },
  });
  assert.equal(agent?.title, "summary");
  assert.equal(agent?.titleRevision, 1);
  assert.equal(agent?.status, "completed");
  for (const patch of [
    { pinned: true },
    { archived: true },
    { status: "running" as const, model: "another-model" },
    { unreadAt: 1002 },
  ]) {
    const updated = await repo.updateTaskState({ ...taskRef, patch });
    assert.equal(updated.title, "summary");
    assert.equal(updated.titleRevision, 1);
  }
  const cleared = await repo.clearTaskUnreadIfMatches({ ...taskRef, expectedUnreadAt: 1002 });
  assert.equal(cleared.meta.titleRevision, 1);
  assert.equal(cleared.cleared, true);
  const seeded = await repo.seedTaskMetaIfMissing({
    ...meta("old baseline", 2000),
    titleRevision: 999,
    forkedFromTaskId: "parent",
  });
  assert.equal(seeded.title, "summary");
  assert.equal(seeded.titleRevision, 1);
  assert.equal(seeded.forkedFromTaskId, "parent");
  const [persisted] = await repo.listTaskMetas({ ...taskRef, pinned: true, archived: true });
  assert.equal(persisted?.titleRevision, 1);
});

test("snapshot revisions cannot version existing automatic or preserved titles", async (t) => {
  const { repo } = await fixture(t);
  await repo.syncTaskMeta({ meta: meta("New session", 10) });
  const replaced = await repo.syncTaskMeta({
    meta: { ...meta("automatic", 11), titleRevision: 900 },
  });
  assert.equal(replaced.title, "automatic");
  assert.equal(replaced.titleRevision, undefined);
  const preserved = await repo.syncTaskMeta({ meta: { ...meta("stale", 12), titleRevision: 901 } });
  assert.equal(preserved.title, "automatic");
  assert.equal(preserved.titleRevision, undefined);
  const patched = await repo.applyAgentPatch({ ...taskRef, patch: { title: "next automatic" } });
  assert.equal(patched?.title, "next automatic");
  assert.equal(patched?.titleRevision, undefined);
  assert.equal((await rename(repo, "next automatic")).titleRevision, 1);
});

test("initial persisted revisions survive reopen and later renames use that watermark", async (t) => {
  const { repo, dbPath } = await fixture(t);
  await repo.seedTaskMetaIfMissing({
    ...meta("seeded", 10),
    titleOverridden: true,
    titleRevision: 7,
  });
  assert.equal((await rename(repo, "summary")).titleRevision, 8);
  repo.close();
  const reopened = new TaskIndexRepo(dbPath);
  try {
    const [persisted] = await reopened.listTaskMetas(taskRef);
    assert.equal(persisted?.title, "summary");
    assert.equal(persisted?.titleRevision, 8);
    assert.equal((await rename(reopened, "after reopen")).titleRevision, 9);
  } finally {
    reopened.close();
  }
});

test("initial snapshot revisions are validated and overflow rolls back the title mutation", async (t) => {
  const { repo } = await fixture(t);
  await assert.rejects(
    repo.syncTaskMeta({
      meta: { ...meta("invalid", 10), titleRevision: -1 },
    }),
  );
  const initial = await repo.syncTaskMeta({
    meta: { ...meta("maximum", 10), titleRevision: Number.MAX_SAFE_INTEGER },
    titleOverridden: true,
  });
  assert.equal(initial.titleRevision, Number.MAX_SAFE_INTEGER);
  assert.equal((await rename(repo, "maximum")).titleRevision, Number.MAX_SAFE_INTEGER);
  await assert.rejects(rename(repo, "overflow"), RangeError);
  const [persisted] = await repo.listTaskMetas(taskRef);
  assert.equal(persisted?.title, "maximum");
  assert.equal(persisted?.titleRevision, Number.MAX_SAFE_INTEGER);
});

test("title revisions stay isolated for the same task and path on different remote identities", async (t) => {
  const { repo } = await fixture(t);
  const identities = ["host-a", "host-b"].map((host) =>
    buildRemoteWorkspaceIdentity(taskRef.workspacePath, { kind: "ssh", host, username: "tester" }),
  );
  for (const workspaceIdentity of identities) {
    await repo.seedTaskMetaIfMissing({ ...meta("initial", 10), workspaceIdentity });
  }
  for (const [index, workspaceIdentity] of identities.entries()) {
    for (let revision = 1; revision <= index + 1; revision++) {
      const renamed = await repo.updateTaskState({
        ...taskRef,
        workspaceIdentity: ` ${workspaceIdentity} `,
        patch: { title: `remote-${index}-${revision}`, titleOverridden: true },
      });
      assert.equal(renamed.titleRevision, revision);
    }
  }
  for (const [index, workspaceIdentity] of identities.entries()) {
    const [row] = await repo.listTaskMetas({
      workspacePath: taskRef.workspacePath,
      workspaceIdentity,
    });
    assert.equal(row?.title, `remote-${index}-${index + 1}`);
    assert.equal(row?.titleRevision, index + 1);
  }
});

test(
  "separate Repo processes serialize concurrent renames against the same SQLite database",
  { timeout: 30_000 },
  async (t) => {
    const { repo, dbPath } = await fixture(t);
    await repo.syncTaskMeta({ meta: meta("initial", 10) });
    const moduleUrl = new URL("../src/session/taskIndexRepo.ts", import.meta.url).href;
    const childCode = `
    import { TaskIndexRepo } from ${JSON.stringify(moduleUrl)};
    const repo = new TaskIndexRepo(process.env.TITLE_TEST_DB);
    await repo.ensureReady();
    process.once("message", async () => {
      try {
        const results = [];
        for (let index = 0; index < 12; index++) {
          const title = process.env.TITLE_TEST_WRITER + "-" + index;
          const meta = await repo.updateTaskState({
            workspacePath: "/example/workspace", taskId: "task-title",
            patch: { title, titleOverridden: true }
          });
          results.push({ title: meta.title, revision: meta.titleRevision });
          await repo.applyAgentPatch({
            workspacePath: "/example/workspace", taskId: "task-title",
            patch: { title: "stale agent title", status: "running" }
          });
          await repo.updateTaskState({
            workspacePath: "/example/workspace", taskId: "task-title", patch: { pinned: true }
          });
          await repo.syncTaskMeta({ meta: {
            ...meta, title: "stale snapshot", titleRevision: 999, updatedAt: 1000
          } });
          await repo.seedTaskMetaIfMissing({ ...meta, title: "stale seed", forkedFromTaskId: "parent" });
          await new Promise(resolve => setImmediate(resolve));
        }
        process.send({ results });
      } catch (error) {
        process.send({ error: String(error) });
      } finally {
        repo.close();
        process.disconnect();
      }
    });
    process.send({ ready: true });
  `;
    const writers = ["a", "b"].map((writer) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childCode],
        {
          env: { ...process.env, TITLE_TEST_DB: dbPath, TITLE_TEST_WRITER: writer },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      t.after(() => {
        child.kill();
      });
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += String(data);
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.on("message", (message) => {
          if ((message as { ready?: boolean }).ready) resolve();
        });
        child.once("exit", () => reject(new Error(stderr || "writer exited before ready")));
      });
      const result = new Promise<Array<{ title: string; revision: number }>>((resolve, reject) => {
        child.once("error", reject);
        child.on("message", (message) => {
          const payload = message as {
            results?: Array<{ title: string; revision: number }>;
            error?: string;
          };
          if (payload.error) reject(new Error(payload.error));
          if (payload.results) resolve(payload.results);
        });
        child.once("exit", () => reject(new Error(stderr || "writer exited before result")));
      });
      const exited = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      return { child, ready, result, exited };
    });
    const ready = Promise.all(writers.map((writer) => writer.ready));
    const results = Promise.all(writers.map((writer) => writer.result));
    await ready;
    for (const writer of writers) writer.child.send("rename");
    const committed = (await results).flat().sort((left, right) => left.revision - right.revision);
    await Promise.all(writers.map((writer) => writer.exited));
    assert.deepEqual(
      committed.map((entry) => entry.revision),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    const [final] = await repo.listTaskMetas(taskRef);
    assert.equal(final?.titleRevision, 24);
    assert.equal(final?.title, committed.at(-1)?.title);
  },
);
