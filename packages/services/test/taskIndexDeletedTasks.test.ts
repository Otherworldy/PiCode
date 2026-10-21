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

// 分支图谱靠 tombstone 里的标题和 forkedFromTaskId 画已删除节点：
// 删除会话时会话本体已物理删除，这里是唯一还能读到它的地方。
test("listTaskMetas({ deleted: true }) 能读到删除 tombstone 的完整 meta", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-deleted-tasks-"));
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    await repo.syncTaskMeta({ meta: meta("root") });
    await repo.syncTaskMeta({
      meta: meta("child", { title: "已删除的分叉", forkedFromTaskId: "root" }),
      deleted: true,
    });

    const deletedRows = await repo.listTaskMetas({ workspacePath: WORKSPACE, deleted: true });
    assert.deepEqual(
      deletedRows.map((row) => row.taskId),
      ["child"],
    );
    assert.equal(deletedRows[0]?.title, "已删除的分叉");
    assert.equal(deletedRows[0]?.forkedFromTaskId, "root");

    const liveRows = await repo.listTaskMetas({ workspacePath: WORKSPACE, deleted: false });
    assert.deepEqual(
      liveRows.map((row) => row.taskId),
      ["root"],
    );

    // 不带 deleted 过滤时两条都在：侧栏列表仍按 membership join 自行排除已删除行。
    const allRows = await repo.listTaskMetas({ workspacePath: WORKSPACE, includeDeleted: true });
    assert.equal(allRows.length, 2);
    repo.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
