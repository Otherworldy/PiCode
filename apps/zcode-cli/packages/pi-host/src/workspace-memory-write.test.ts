import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createWorkspaceMemoryExtension } from "./workspace-memory.js";
import { normalizeWorkspaceMemoryWrite } from "./workspace-memory-write.js";
import { resolveWorkspaceMemoryRoot } from "@zcode/shared/node";

async function withWorkspace(
  run: (input: { workspacePath: string; root: string }) => Promise<void>,
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-pi-mem-write-"));
  const root = resolveWorkspaceMemoryRoot(workspacePath);
  await mkdir(root, { recursive: true });
  try {
    await run({ workspacePath, root });
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

test("direct write gets missing frontmatter fields and an index pointer line", async () => {
  await withWorkspace(async ({ workspacePath, root }) => {
    await writeFile(
      join(root, "test-runner.md"),
      "---\nname: test-runner\ndescription: 测试与 pnpm\ntype: convention\n---\n\n跑测试用 pnpm test。\n",
    );
    const fileName = await normalizeWorkspaceMemoryWrite({
      workspacePath,
      memoryRoot: root,
      // 相对路径按 workspacePath 解析成 `.pi/memory/test-runner.md`。
      target: join(".pi", "memory", "test-runner.md"),
      today: "2026-11-03",
    });
    assert.equal(fileName, "test-runner.md");
    const content = await readFile(join(root, "test-runner.md"), "utf-8");
    assert.match(content, /^---\nname: test-runner\n/);
    assert.match(content, /\ncategory: project\n/);
    // 非法枚举回退到缺省，而不是把 `convention` 原样留下。
    assert.match(content, /\ntype: fact\n/);
    assert.match(content, /\nsource: assistant\n/);
    assert.match(content, /\nconfirmed: false\n/);
    assert.match(content, /\nlastConfirmed: 2026-11-03\n/);
    assert.match(content, /跑测试用 pnpm test。\n$/);
    assert.match(
      (await readFile(join(root, "MEMORY.md"), "utf-8")) ?? "",
      /- \[test-runner\]\(test-runner\.md\) — 测试与 pnpm/,
    );
  });
});

test("direct write keeps valid fields, unknown keys and stays idempotent", async () => {
  await withWorkspace(async ({ workspacePath, root }) => {
    const original = [
      "---",
      "name: deploy",
      "description: 部署方式：docker compose",
      "category: project",
      "type: constraint",
      "source: user",
      "confirmed: true",
      "lastConfirmed: 2026-01-02",
      "expires: 2027-01-01",
      "tags: infra",
      "---",
      "",
      "端口映射 8080:80。",
      "",
    ].join("\n");
    await writeFile(join(root, "deploy.md"), original);
    const changed = await normalizeWorkspaceMemoryWrite({
      workspacePath,
      memoryRoot: root,
      target: join(root, "deploy.md"),
      today: "2026-11-03",
    });
    // 全字段合法：一字不改，也不再补索引（对账在落盘路径上）。
    assert.equal(changed, null);
    assert.equal(await readFile(join(root, "deploy.md"), "utf-8"), original);
    assert.match(original, /tags: infra/);
  });
});

test("direct write ignores the index file and paths outside the memory root", async () => {
  await withWorkspace(async ({ workspacePath, root }) => {
    await writeFile(join(root, "a.md"), "---\nname: a\n---\n\nbody\n");
    assert.equal(
      await normalizeWorkspaceMemoryWrite({
        workspacePath,
        memoryRoot: root,
        target: join(root, "MEMORY.md"),
        today: "2026-11-03",
      }),
      null,
    );
    // 相对路径的基准是 workspacePath：`src/index.ts` 是业务代码，
    // 甚至连项目根下的 `note.md` 也不在记忆目录里。
    assert.equal(
      await normalizeWorkspaceMemoryWrite({
        workspacePath,
        memoryRoot: root,
        target: "src/index.ts",
        today: "2026-11-03",
      }),
      null,
    );
    assert.equal(
      await normalizeWorkspaceMemoryWrite({
        workspacePath,
        memoryRoot: root,
        target: "note.md",
        today: "2026-11-03",
      }),
      null,
    );
  });
});

test("memory extension normalizes Write tool results into the memory root", async () => {
  await withWorkspace(async ({ workspacePath, root }) => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const pi = {
      on: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
    };
    createWorkspaceMemoryExtension({ root, workspacePath, enabled: true })(pi as never);
    await writeFile(join(root, "note.md"), "---\nname: note\n---\n\n手动写入。\n");
    handlers.tool_result?.({
      // Pi 内置工具名是小写；大写的是投影层给 UI 的展示名。
      toolName: "write",
      isError: false,
      input: { path: join(root, "note.md") },
    });
    // 钩子是旁路，等待它落盘。
    await new Promise((done) => setTimeout(done, 100));
    assert.match(
      (await readFile(join(root, "MEMORY.md"), "utf-8")) ?? "",
      /- \[note\]\(note\.md\) — 手动写入。/,
    );
  });
});
