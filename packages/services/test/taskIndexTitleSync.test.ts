import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

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
  const dir = await mkdtemp(join(tmpdir(), "zcode-title-sync-"));
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
  const dir = await mkdtemp(join(tmpdir(), "zcode-title-sync-"));
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
