import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  forgetPiPluginUpdate,
  piPluginUpdateCacheKey,
  readPiPluginUpdateCache,
  readPiPluginUpdateView,
  savePiPluginUpdateCache,
  savePiPluginUpdateCheck,
} from "./pi-plugin-update-cache.js";

const userPlugin = {
  id: "pkg:user:npm:pi-subagents",
  source: "npm:pi-subagents",
  scope: "user" as const,
  name: "pi-subagents",
};

const otherUser = {
  id: "pkg:user:npm:other",
  source: "npm:other",
  scope: "user" as const,
  name: "other",
};

const projectPlugin = {
  id: "pkg:project:npm:local",
  source: "npm:local",
  scope: "project" as const,
  name: "local",
};

function idsOf(cache: { updates: Array<{ id: string }> } | undefined): string[] {
  return cache?.updates.map((item) => item.id) ?? [];
}

test("user plugin updates are shared and an older check cannot restore one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const first = piPluginUpdateCacheKey("D:\\proj", "  ident  ");
  const second = piPluginUpdateCacheKey("D:\\other");
  assert.equal(first, "ident");
  assert.equal(await readPiPluginUpdateView(first, root), undefined);

  const startedAt = Date.now();
  const saved = await savePiPluginUpdateCheck(
    first,
    [userPlugin, otherUser, projectPlugin],
    startedAt,
    root,
  );
  assert.equal(typeof saved?.checkedAt, "number");
  assert.deepEqual(idsOf(saved).sort(), [otherUser.id, projectPlugin.id, userPlugin.id].sort());
  assert.deepEqual(idsOf(await readPiPluginUpdateView(second, root)), [
    userPlugin.id,
    otherUser.id,
  ]);

  const during = Date.now();
  const forgotten = await forgetPiPluginUpdate(first, userPlugin.id, root);
  assert.equal(forgotten?.checkedAt, saved?.checkedAt);
  assert.deepEqual(idsOf(forgotten), [otherUser.id, projectPlugin.id]);
  assert.deepEqual(idsOf(await readPiPluginUpdateView(second, root)), [otherUser.id]);

  const ignored = await savePiPluginUpdateCheck(
    first,
    [userPlugin, otherUser, projectPlugin],
    1,
    root,
  );
  assert.deepEqual(idsOf(ignored), idsOf(forgotten));

  const stale = await savePiPluginUpdateCheck(second, [userPlugin, otherUser], during, root);
  assert.equal(idsOf(stale).includes(userPlugin.id), false);
  assert.equal(idsOf(await readPiPluginUpdateView(first, root)).includes(userPlugin.id), false);

  const again = await savePiPluginUpdateCheck(first, [userPlugin], Date.now() + 1_000, root);
  assert.equal(idsOf(again).includes(userPlugin.id), true);
  assert.equal(idsOf(await readPiPluginUpdateView(second, root)).includes(userPlugin.id), true);
});

test("project plugin update cache stays on that workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const first = piPluginUpdateCacheKey("D:\\one");
  const second = piPluginUpdateCacheKey("D:\\two");
  const startedAt = Date.now();
  await savePiPluginUpdateCheck(first, [projectPlugin], startedAt, root);
  await savePiPluginUpdateCheck(
    second,
    [{ ...projectPlugin, id: "pkg:project:npm:two", name: "two" }],
    startedAt,
    root,
  );

  const forgotten = await forgetPiPluginUpdate(first, projectPlugin.id, root);
  assert.deepEqual(idsOf(forgotten), []);
  assert.deepEqual(idsOf(await readPiPluginUpdateView(second, root)), ["pkg:project:npm:two"]);
});

test("legacy per-workspace user updates are ignored until a global check exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const key = piPluginUpdateCacheKey("/work");
  await savePiPluginUpdateCache(key, [userPlugin, projectPlugin], 50, root);
  const view = await readPiPluginUpdateView(key, root);
  assert.deepEqual(idsOf(view), [projectPlugin.id]);
  assert.equal(view?.checkedAt, undefined);
});

test("unreadable plugin update cache counts as never checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const key = piPluginUpdateCacheKey("/work");
  await savePiPluginUpdateCache(key, [userPlugin], 10, root);
  const file = join(root, "pi-plugin-update-cache", createHash("sha256").update(key).digest("hex"));
  await writeFile(file, "{");
  assert.equal(await readPiPluginUpdateCache(key, root), undefined);
});
