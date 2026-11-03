import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureWorkspaceMemoryRoot,
  isWorkspaceMemoryMarkdownTarget,
  readWorkspaceMemoryEnabled,
  readWorkspaceMemoryModel,
  resolveWorkspaceMemoryRoot,
  setWorkspaceMemoryEnabled,
  setWorkspaceMemoryModel,
} from "@zcode/shared/node";
import { createMemoryService } from "../src/memory/memoryService.js";

async function writeWorkspaceConfig(workspacePath: string, text: string): Promise<void> {
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(join(workspacePath, ".pi", "picode.json"), text);
}

async function withWorkspace(run: (workspacePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-workspace-memory-"));
  try {
    const workspacePath = join(dir, "project");
    await mkdir(workspacePath, { recursive: true });
    await run(workspacePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("workspace memory root is inside the project .pi directory", () => {
  const workspacePath = join(tmpdir(), "demo-project");
  assert.equal(resolveWorkspaceMemoryRoot(workspacePath), join(workspacePath, ".pi", "memory"));
});

test("memory switch defaults to disabled and only explicit true enables it", async () => {
  await withWorkspace(async (workspacePath) => {
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), false);
    await writeWorkspaceConfig(workspacePath, JSON.stringify({ features: { memory: true } }));
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
    await writeWorkspaceConfig(workspacePath, JSON.stringify({ features: { memory: false } }));
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), false);
    await writeWorkspaceConfig(workspacePath, JSON.stringify({ memory: { use: true } }));
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
    await writeWorkspaceConfig(workspacePath, "{ broken");
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), false);
  });
});

test("legacy root zcode.json is copied to .pi/picode.json on read", async () => {
  await withWorkspace(async (workspacePath) => {
    const legacyText = JSON.stringify({ features: { memory: true } });
    await writeFile(join(workspacePath, "zcode.json"), legacyText);
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
    assert.equal(await readFile(join(workspacePath, ".pi", "picode.json"), "utf-8"), legacyText);
    assert.equal(await readFile(join(workspacePath, "zcode.json"), "utf-8"), legacyText);
  });
});

test("setWorkspaceMemoryEnabled preserves other project config keys", async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, ".pi"), { recursive: true });
    const configPath = join(workspacePath, ".pi", "picode.json");
    await writeFile(
      configPath,
      JSON.stringify({ features: { memory: true, skill: false }, theme: "x" }),
    );
    await setWorkspaceMemoryEnabled(workspacePath, false);
    const config = JSON.parse(await readFile(configPath, "utf-8")) as {
      features: { memory: boolean; skill: boolean };
      theme: string;
    };
    assert.equal(config.features.memory, false);
    assert.equal(config.features.skill, false);
    assert.equal(config.theme, "x");
  });
});

test("memory catalog reads only the project directory", async () => {
  await withWorkspace(async (workspacePath) => {
    const memoryRoot = resolveWorkspaceMemoryRoot(workspacePath);
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Index\n");
    await writeFile(join(memoryRoot, "workflow.md"), "# Workflow\n");
    await writeFile(join(memoryRoot, "not-a-memory.txt"), "ignored");

    const service = createMemoryService();
    const catalog = await service.listProjectMemories({ workspaces: [{ workspacePath }] });
    assert.equal(catalog.length, 1);
    assert.deepEqual(
      catalog[0]?.files.map((file) => file.name),
      ["MEMORY.md", "workflow.md"],
    );
    const file = await service.readProjectMemoryFile({ workspacePath, fileName: "workflow.md" });
    assert.equal(file.content, "# Workflow\n");
  });
});

test("remote workspace refs are skipped", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    const catalog = await service.listProjectMemories({
      workspaces: [{ workspacePath, workspaceIdentity: "remote:ssh:host:22:user:/srv/app" }],
    });
    assert.deepEqual(catalog, []);
    assert.equal(
      await service.getWorkspaceMemoryEnabled({
        workspacePath,
        workspaceIdentity: "remote:ssh:host:22:user:/srv/app",
      }),
      false,
    );
  });
});

test("memory files can be created, edited and deleted", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    const memoryFile = join(workspacePath, ".pi", "memory", "build-command.md");
    const first = `# Build

pnpm build`;
    const second = `# Build

pnpm -r build`;
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "build-command.md",
      content: first,
    });
    assert.equal(await readFile(memoryFile, "utf-8"), first);
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "build-command.md",
      content: second,
    });
    assert.equal(await readFile(memoryFile, "utf-8"), second);
    const catalog = await service.listProjectMemories({ workspaces: [{ workspacePath }] });
    assert.deepEqual(
      catalog[0]?.files.map((file) => file.name),
      ["MEMORY.md", "build-command.md"],
    );
    // 新项目的第一条记忆要自己把索引建起来，否则永远进不了注入。
    assert.equal(catalog[0]?.files[0]?.missing, undefined);
    assert.match(
      await readFile(join(workspacePath, ".pi", "memory", "MEMORY.md"), "utf-8"),
      /build-command\.md/,
    );
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "MEMORY.md",
      content: "- [Build](build-command.md) — pnpm build",
    });
    const indexed = await service.listProjectMemories({ workspaces: [{ workspacePath }] });
    assert.equal(indexed[0]?.files[0]?.missing, undefined);
    await service.deleteProjectMemoryFile({ workspacePath, fileName: "build-command.md" });
    const emptied = await service.listProjectMemories({ workspaces: [{ workspacePath }] });
    assert.deepEqual(
      emptied[0]?.files.map((file) => file.name),
      ["MEMORY.md"],
    );
    assert.doesNotMatch(
      await readFile(join(workspacePath, ".pi", "memory", "MEMORY.md"), "utf-8"),
      /build-command\.md/,
    );
    assert.equal(emptied[0]?.files[0]?.missing, undefined);
    assert.doesNotMatch(
      await readFile(join(workspacePath, ".pi", "memory", "MEMORY.md"), "utf-8"),
      /build-command\.md/,
    );
    await assert.rejects(() =>
      service.writeProjectMemoryFile({
        workspacePath,
        fileName: "../escape.md",
        content: "x",
      }),
    );
    await assert.rejects(() =>
      service.writeProjectMemoryFile({
        workspacePath,
        fileName: "huge.md",
        content: "x".repeat(64 * 1024 + 1),
      }),
    );
  });
});

test("editing memory files keeps MEMORY.md in sync with the directory", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    const memoryRoot = resolveWorkspaceMemoryRoot(workspacePath);
    await ensureWorkspaceMemoryRoot(workspacePath);
    await writeFile(join(memoryRoot, "MEMORY.md"), "- [Build](build-command.md) — pnpm build\n");
    await writeFile(
      join(memoryRoot, "build-command.md"),
      "---\nname: Build\ndescription: pnpm build\n---\n",
    );
    // UI 新建条目：没人手工补指针，也要能进索引，否则永远注入不到。
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "deploy.md",
      content: "---\nname: Deploy\ndescription: docker compose\n---\n",
    });
    let index = await readFile(join(memoryRoot, "MEMORY.md"), "utf-8");
    assert.match(index, /- \[Deploy\]\(deploy\.md\) — docker compose/);
    // UI 删除条目：指向它的指针行要一起清掉，否则主模型下一轮还看得到死链。
    await service.deleteProjectMemoryFile({ workspacePath, fileName: "build-command.md" });
    index = await readFile(join(memoryRoot, "MEMORY.md"), "utf-8");
    assert.doesNotMatch(index, /build-command\.md/);
    assert.match(index, /deploy\.md/);
  });
});

test("workspace memory model is stored per project and can be cleared", async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, ".pi"), { recursive: true });
    const configPath = join(workspacePath, ".pi", "picode.json");
    await writeFile(
      configPath,
      JSON.stringify({ features: { memory: true, skill: false }, theme: "x" }),
    );
    await setWorkspaceMemoryModel(workspacePath, { providerId: "lens", modelId: "fast" });
    assert.deepEqual(await readWorkspaceMemoryModel(workspacePath), {
      providerId: "lens",
      modelId: "fast",
    });
    const config = JSON.parse(await readFile(configPath, "utf-8")) as {
      features: {
        memory: boolean;
        skill: boolean;
        memoryModel: { provider: string; model: string };
      };
      theme: string;
    };
    assert.equal(config.features.memory, true);
    assert.equal(config.features.skill, false);
    assert.equal(config.theme, "x");
    assert.deepEqual(config.features.memoryModel, { provider: "lens", model: "fast" });

    const service = createMemoryService();
    assert.deepEqual(await service.getWorkspaceMemoryModel({ workspacePath }), {
      providerId: "lens",
      modelId: "fast",
    });
    await service.setWorkspaceMemoryModel({ workspacePath, model: null });
    assert.equal(await service.getWorkspaceMemoryModel({ workspacePath }), null);
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
  });
});

test("write target guard rejects nested paths and symlinks", async () => {
  await withWorkspace(async (workspacePath) => {
    const memoryRoot = resolveWorkspaceMemoryRoot(workspacePath);
    await mkdir(join(memoryRoot, "nested"), { recursive: true });
    assert.equal(
      await isWorkspaceMemoryMarkdownTarget(workspacePath, join(memoryRoot, "workflow.md")),
      true,
    );
    assert.equal(
      await isWorkspaceMemoryMarkdownTarget(
        workspacePath,
        join(memoryRoot, "nested", "workflow.md"),
      ),
      false,
    );
    assert.equal(
      await isWorkspaceMemoryMarkdownTarget(workspacePath, join(memoryRoot, "README.txt")),
      false,
    );
    const outside = join(workspacePath, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, join(memoryRoot, "linked.md")).catch(() => undefined);
    assert.equal(
      await isWorkspaceMemoryMarkdownTarget(workspacePath, join(memoryRoot, "linked.md")),
      false,
    );
  });
});

test("symlinked memory root is rejected", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(workspacePath, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(join(workspacePath, ".pi"), { recursive: true });
    const memoryRoot = resolveWorkspaceMemoryRoot(workspacePath);
    try {
      await symlink(outside, memoryRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // 没有 symlink 权限的环境跳过。
    }
    await assert.rejects(() => ensureWorkspaceMemoryRoot(workspacePath));
    assert.equal(
      await isWorkspaceMemoryMarkdownTarget(workspacePath, join(memoryRoot, "scratch.md")),
      false,
    );
  });
});

test("catalog exposes the frontmatter category of item files", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "theme.md",
      content: "---\nname: Theme\ncategory: ui\n---\nbody\n",
    });
    await service.writeProjectMemoryFile({
      workspacePath,
      fileName: "plain.md",
      content: "# Plain\n\nno frontmatter\n",
    });
    const catalog = await service.listProjectMemories({ workspaces: [{ workspacePath }] });
    const files = catalog[0]?.files ?? [];
    assert.equal(files.find((file) => file.name === "theme.md")?.category, "ui");
    // 缺 frontmatter 的旧文件按缺省分类展示，不报错也不丢。
    assert.equal(files.find((file) => file.name === "plain.md")?.category, "project");
    assert.equal(files.find((file) => file.name === "MEMORY.md")?.category, undefined);
  });
});

test("expiry days round-trips and only touches features.memoryExpiryDays", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    await writeWorkspaceConfig(
      workspacePath,
      JSON.stringify({ features: { memory: true, memoryModel: { provider: "p", model: "m" } } }),
    );
    // 未配置时给默认值（0 = 只按 expires），而不是 undefined。
    assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 0);

    await service.setWorkspaceMemoryExpiryDays({ workspacePath, days: 30 });
    assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 30);
    const saved = JSON.parse(await readFile(join(workspacePath, ".pi", "picode.json"), "utf-8"));
    assert.equal(saved.features.memoryExpiryDays, 30);
    assert.equal(saved.features.memory, true);
    assert.deepEqual(saved.features.memoryModel, { provider: "p", model: "m" });

    // 0 表示只保留 expires 显式到期，写入后与默认值等价。
    await service.setWorkspaceMemoryExpiryDays({ workspacePath, days: 0 });
    assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 0);

    // null 删除配置，回到默认。
    await service.setWorkspaceMemoryExpiryDays({ workspacePath, days: null });
    assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 0);
    const cleared = JSON.parse(await readFile(join(workspacePath, ".pi", "picode.json"), "utf-8"));
    assert.equal("memoryExpiryDays" in cleared.features, false);
    assert.equal(cleared.features.memory, true);
  });
});

test("expiry days config ignores invalid values", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    for (const value of [-5, "30", null, true]) {
      await writeWorkspaceConfig(
        workspacePath,
        JSON.stringify({ features: { memoryExpiryDays: value } }),
      );
      assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 0);
    }
    // 小数向下取整，避免 UI 显示 30 实际存 30.7。
    await writeWorkspaceConfig(
      workspacePath,
      JSON.stringify({ features: { memoryExpiryDays: 30.7 } }),
    );
    assert.equal(await service.getWorkspaceMemoryExpiryDays({ workspacePath }), 30);
  });
});

test("remote workspaces report the default expiry and reject writes", async () => {
  await withWorkspace(async (workspacePath) => {
    const service = createMemoryService();
    const workspaceIdentity = "remote:ssh:host:22:user:/srv/app";
    assert.equal(
      await service.getWorkspaceMemoryExpiryDays({ workspacePath, workspaceIdentity }),
      0,
    );
    await assert.rejects(
      service.setWorkspaceMemoryExpiryDays({ workspacePath, workspaceIdentity, days: 30 }),
      /local workspaces/,
    );
  });
});
