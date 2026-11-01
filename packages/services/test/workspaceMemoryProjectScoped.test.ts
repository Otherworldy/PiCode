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
    await writeFile(
      join(workspacePath, "zcode.json"),
      JSON.stringify({ features: { memory: true } }),
    );
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
    await writeFile(
      join(workspacePath, "zcode.json"),
      JSON.stringify({ features: { memory: false } }),
    );
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), false);
    await writeFile(join(workspacePath, "zcode.json"), JSON.stringify({ memory: { use: true } }));
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), true);
    await writeFile(join(workspacePath, "zcode.json"), "{ broken");
    assert.equal(await readWorkspaceMemoryEnabled(workspacePath), false);
  });
});

test("setWorkspaceMemoryEnabled preserves other project config keys", async () => {
  await withWorkspace(async (workspacePath) => {
    const configPath = join(workspacePath, "zcode.json");
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
    assert.equal(catalog[0]?.files[0]?.missing, true);
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
    assert.equal(emptied[0]?.files[0]?.missing, undefined);
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

test("workspace memory model is stored per project and can be cleared", async () => {
  await withWorkspace(async (workspacePath) => {
    const configPath = join(workspacePath, "zcode.json");
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
