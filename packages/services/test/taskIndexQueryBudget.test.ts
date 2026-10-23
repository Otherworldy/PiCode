import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const WORKSPACE = "/example/budget-ws";

// 贴近真实上限的正文：列表路径不该碰它，搜索路径只该搬出一小段。
const SAMPLE_BODY = "会话正文 Hello World 用于测试搜索 " + "abc ".repeat(2000);
const LARGE_BODY = SAMPLE_BODY.repeat(Math.ceil(200_000 / SAMPLE_BODY.length)).slice(0, 200_000);

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
  } as ZCodeTaskMeta;
}

async function withRepo(run: (repo: TaskIndexRepo, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-taskindex-budget-"));
  const dbPath = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  try {
    await run(repo, dbPath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function readBody(dbPath: string, taskId: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(`SELECT searchable_text AS t FROM tasks WHERE workspace_key = ? AND task_id = ?`)
      .get(WORKSPACE, taskId) as { t: string } | undefined;
    return row?.t ?? "";
  } finally {
    db.close();
  }
}

// 列表路径（侧栏刷新 1 + 4×scopes 次）绝不能把 200k 的正文搬出来：
// 它是 rowToMeta 完全不读的列，读一次就是 MB 级分配。
test("listTaskMetas 不搬运 searchable_text", async () => {
  await withRepo(async (repo, dbPath) => {
    const rows = 50;
    for (let i = 0; i < rows; i += 1) {
      await repo.syncTaskMeta({ meta: meta(`t${i}`), searchableText: LARGE_BODY });
    }

    const listStart = performance.now();
    const metas = await repo.listTaskMetas({ workspacePath: WORKSPACE });
    const listMs = performance.now() - listStart;
    assert.equal(metas.length, rows);

    // 同样行数、含正文列的全列读，作为「读放大」的对照基准。
    const db = new DatabaseSync(dbPath);
    const fullSelect = db.prepare(
      `SELECT workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
              provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
              off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned,
              archived, deleted, title_overridden, searchable_text, meta_json
       FROM tasks WHERE workspace_key = ? AND deleted = 0`,
    );
    const fullStart = performance.now();
    for (let i = 0; i < 5; i += 1) fullSelect.all(WORKSPACE);
    const fullMs = (performance.now() - fullStart) / 5;
    db.close();

    // 阈值放宽到 3 倍：真实差距在 30 倍量级（50 × 200k 字符）。
    assert.ok(
      listMs * 3 < fullMs,
      `listTaskMetas ${listMs.toFixed(1)}ms 应明显快于全列 ${fullMs.toFixed(1)}ms`,
    );
  });
});

test("搜索命中正文并只返回小摘要", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta("hit"), searchableText: LARGE_BODY });

    const result = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      search: "测试搜索",
      limit: 10,
    } as never);

    assert.equal(result.total, 1);
    const snippet = result.items[0]?.searchSnippet ?? "";
    assert.ok(snippet.includes("测试搜索"), `摘要应包含匹配内容：${snippet.slice(0, 40)}`);
    // 摘要来自 SQL 侧 substr，不可能等于整段正文。
    assert.ok(snippet.length < 300, `摘要长度应远小于正文：${snippet.length}`);
  });
});

test("搜索位置对大小写口径与谓词一致", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta("case"), searchableText: LARGE_BODY });

    // 正文里是大写 "Hello World"，用小写查询：谓词（LIKE）命中，位置（instr+lower）也必须命中，
    // 否则摘要窗口会退化为正文开头。
    const result = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      search: "hello world",
      limit: 10,
    } as never);

    assert.equal(result.total, 1);
    assert.ok(/Hello World/i.test(result.items[0]?.searchSnippet ?? ""));
  });
});

// provider 参与 WHERE 绑定：它插在 workspaceKeys 与两个 LIKE 值之间。绑定顺序错位不会抛错，
// 只会静默返回错摘要或错行，所以这条路径必须有断言。
test("provider 参与绑定顺序时搜索仍正确", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta("with-provider"), searchableText: LARGE_BODY });

    const withProvider = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      search: "测试搜索",
      limit: 10,
      provider: "glm",
    } as never);
    assert.equal(withProvider.total, 1);
    assert.ok((withProvider.items[0]?.searchSnippet ?? "").includes("测试搜索"));

    const otherProvider = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      search: "测试搜索",
      limit: 10,
      provider: "codex",
    } as never);
    assert.equal(otherProvider.total, 0, "provider 过滤应生效");
  });
});

// writeRecord 的正文 UPDATE 是条件执行的；patch 不带正文时正文必须原样保留。
test("标题 patch 保留正文，传 searchableText 时更新", async () => {
  await withRepo(async (repo, dbPath) => {
    await repo.syncTaskMeta({ meta: meta("keep"), searchableText: LARGE_BODY });
    assert.equal(readBody(dbPath, "keep").length, LARGE_BODY.length);

    await repo.syncTaskMeta({ meta: meta("keep", { title: "改过的标题", updatedAt: 9 }) });
    assert.equal(readBody(dbPath, "keep"), LARGE_BODY, "不带正文的 patch 必须原样保留");

    await repo.syncTaskMeta({
      meta: meta("keep", { title: "改过的标题", updatedAt: 10 }),
      searchableText: "全新的独特内容 zzzuniquezzz",
    });
    assert.ok(readBody(dbPath, "keep").includes("zzzuniquezzz"));

    const found = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      search: "zzzuniquezzz",
      limit: 10,
    } as never);
    assert.equal(found.total, 1, "新正文必须立即可搜到");
  });
});

// includesDeleted 且无其它过滤时 where 为空，SQL 必须仍然合法。
test("where 为空时全量查询仍合法", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta("live") });
    await repo.syncTaskMeta({ meta: meta("gone"), deleted: true });

    const all = await repo.listTaskMetas({ includeDeleted: true });
    assert.deepEqual(all.map((row) => row.taskId).sort(), ["gone", "live"]);

    const live = await repo.listTaskMetas({ workspacePath: WORKSPACE });
    assert.deepEqual(
      live.map((row) => row.taskId),
      ["live"],
    );

    const providerOnly = await repo.listTaskMetas({ provider: "glm" as never });
    assert.equal(providerOnly.length, 1, "只按 provider 过滤时也要排除 tombstone");
  });
});

// 删除 tombstone 的列兜底：off_peak_task_id 只写在列上、meta_json 还没回填时，
// grouped 视图入口必须能读到它。
test("queryGroupedTaskView 保留 off_peak 列兜底", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta("offpeak", { offPeakTaskId: "op-1" }) });

    const view = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
    } as never);
    const flattened = JSON.stringify(view);
    assert.ok(flattened.includes("op-1"), "grouped 视图应带出 offPeakTaskId");
  });
});
