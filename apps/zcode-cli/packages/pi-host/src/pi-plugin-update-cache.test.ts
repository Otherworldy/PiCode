import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  forgetPiPluginUpdate,
  piPluginUpdateCacheKey,
  readPiPluginUpdateCache,
  savePiPluginUpdateCache,
} from "./pi-plugin-update-cache.js";

const sample = {
  id: "pkg:user:npm:pi-subagents",
  source: "npm:pi-subagents",
  scope: "user" as const,
  name: "pi-subagents",
};

test("plugin update cache is kept per workspace and drops an updated plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const key = piPluginUpdateCacheKey("D:\\proj", "  ident  ");
  assert.equal(key, "ident");
  assert.equal(await readPiPluginUpdateCache(key, root), undefined);

  const saved = await savePiPluginUpdateCache(
    key,
    [sample, { ...sample, id: "pkg:user:npm:other", name: "other" }],
    50,
    root,
  );
  assert.equal(saved.checkedAt, 50);
  assert.equal((await readPiPluginUpdateCache(key, root))?.updates.length, 2);

  const forgotten = await forgetPiPluginUpdate(key, sample.id, root);
  assert.equal(forgotten?.checkedAt, 50);
  assert.deepEqual(
    forgotten?.updates.map((item) => item.id),
    ["pkg:user:npm:other"],
  );
  assert.equal(await forgetPiPluginUpdate("missing", sample.id, root), undefined);
});

test("unreadable plugin update cache counts as never checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-updates-"));
  const key = piPluginUpdateCacheKey("/work");
  await savePiPluginUpdateCache(key, [sample], 10, root);
  const { createHash } = await import("node:crypto");
  const file = join(root, "pi-plugin-update-cache", createHash("sha256").update(key).digest("hex"));
  await writeFile(file, "{");
  assert.equal(await readPiPluginUpdateCache(key, root), undefined);
});
