import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const WORKSPACE = "/example/workspace";

function meta(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}` as ZCodeTaskMeta["traceId"],
    workspacePath: WORKSPACE,
    title: taskId,
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

// 早期版本没有把 Pi jsonl 头部里的 parentSession 落到 tasks-index，
// 已有行的 forked_from_task_id 是空的。基线摘要必须能补写这一列，否则分支图谱永远没有边。
test("seedTaskMetaIfMissing 给已有行补写分叉来源，且不覆盖已有来源", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fork-lineage-"));
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    // 先落后端行（模拟 createTask 在建会话时写入、还没有分叉关系的状态）。
    await repo.seedTaskMetaIfMissing(meta("child", { title: "分支-初始问候" }));

    // 基线摘要带上了 parentSessionId，已有行补齐来源。
    const backfilled = await repo.seedTaskMetaIfMissing(
      meta("child", { title: "分支-初始问候", forkedFromTaskId: "parent" }),
    );
    assert.equal(backfilled.forkedFromTaskId, "parent");

    // 再换一个来源不能改写：分叉来源是历史事实。
    const kept = await repo.seedTaskMetaIfMissing(
      meta("child", { title: "分支-初始问候", forkedFromTaskId: "other-parent" }),
    );
    assert.equal(kept.forkedFromTaskId, "parent");

    // 同步运行态快照时不带 parentSessionId，也不能把来源冲掉。
    const synced = await repo.syncTaskMeta({ meta: meta("child", { title: "分支-初始问候" }) });
    assert.equal(synced.forkedFromTaskId, "parent");
    repo.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
