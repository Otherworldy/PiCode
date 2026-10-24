import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGenUiStateStorage } from "./stateStorage.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
describe("desktop Gen UI state persistence", () => {
  it("keeps the latest 100 paths and serializes writes across service instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = createGenUiStateStorage(root),
      b = createGenUiStateStorage(root);
    cleanup.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const scope = { workspacePath: "/workspace", sessionId: "task" };
    for (let i = 0; i < 102; i++)
      await (i % 2 ? a : b).set(
        { ...scope, path: `/workspace/view-${i}.html` },
        { modelContent: i, privateContent: null },
      );
    const entries = await b.list(scope);
    expect(entries).toHaveLength(100);
    expect(entries.some((entry) => entry.path === "/workspace/view-101.html")).toBe(true);
    expect(await a.get({ ...scope, path: "/workspace/view-0.html" })).toBeNull();
  });
  it("keeps notifying sibling cards after their scope directory is evicted", async () => {
    // scope LRU 淘汰时连 targets 一起清；publishLatest 用记录自带的 target 兜底，
    // 所以同目录其他卡片不会因为「watcher 被挤出去又回来」而静默失联。
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const storage = createGenUiStateStorage(root);
    cleanup.push(() => storage.dispose());

    const scope = { workspacePath: "/workspace", sessionId: "evict" };
    const cardA = { ...scope, path: "/workspace/card-a.html" };
    const cardB = { ...scope, path: "/workspace/card-b.html" };
    await storage.set(cardA, { modelContent: 1, privateContent: null });
    await storage.set(cardB, { modelContent: 1, privateContent: null });

    const dirs = (await readdir(root)).filter((name) => !name.startsWith("."));
    expect(dirs).toHaveLength(1);
    const dir = join(root, dirs[0]!);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    expect(files, "同一 scope 的两张卡片应共用一个目录").toHaveLength(2);

    // 让 MAX_WATCHED_SCOPES = 8 把这个目录挤出去。
    for (let index = 0; index < 9; index += 1) {
      await storage.set(
        {
          workspacePath: "/workspace",
          sessionId: `other-${index}`,
          path: `/workspace/other-${index}.html`,
        },
        { modelContent: 1, privateContent: null },
      );
    }

    // 卡片 A 重新 observe：只有 A 回到 targets，B 的映射已随淘汰清掉。
    await storage.get(cardA);

    let cardBFile = "";
    for (const name of files) {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as {
        target: { path: string };
      };
      if (record.target.path === cardB.path) cardBFile = join(dir, name);
    }
    expect(cardBFile, "应能找到卡片 B 的记录文件").not.toBe("");

    const seen: string[] = [];
    const subscription = storage.onChanged((change) => seen.push(change.target.path));
    cleanup.push(() => subscription.dispose());

    const record = JSON.parse(await readFile(cardBFile, "utf8")) as {
      state: unknown;
      updatedAt: number;
    };
    record.state = { modelContent: 2, privateContent: null };
    record.updatedAt = Date.now() + 1_000;
    await writeFile(cardBFile, JSON.stringify(record), "utf8");

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen, "淘汰后卡片 B 的写入必须仍然通知").toContain(cardB.path);
  });

  it("restores across service instances and serializes complete snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const first = createGenUiStateStorage(root),
      second = createGenUiStateStorage(root);
    cleanup.push(
      () => first.dispose(),
      () => second.dispose(),
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await Promise.all(
      [1, 2, 3].map((tab) => first.set(target, { modelContent: null, privateContent: { tab } })),
    );
    expect(await second.get(target)).toEqual({ modelContent: null, privateContent: { tab: 3 } });
    expect(await second.get({ ...target, workspaceIdentity: "remote-example" })).toBeNull();
    await second.set(target, { modelContent: { year: 2026 }, privateContent: null });
    expect(await first.get(target)).toEqual({ modelContent: { year: 2026 }, privateContent: null });
  });
  it("broadcasts external writes without echo loops", async () => {
    const root = await mkdtemp(join(tmpdir(), "gen-ui-state-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = createGenUiStateStorage(root),
      b = createGenUiStateStorage(root);
    cleanup.push(
      () => a.dispose(),
      () => b.dispose(),
    );
    const target = {
      workspacePath: "/workspace",
      sessionId: "task",
      path: "/workspace/chart.html",
    };
    await a.get(target);
    const changed = new Promise<unknown>((resolve) => {
      const off = a.onChanged((event) => {
        off.dispose();
        resolve(event.state);
      });
    });
    await b.set(target, { modelContent: "selection", privateContent: null });
    expect(await changed).toEqual({ modelContent: "selection", privateContent: null });
  });
});
