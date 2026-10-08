import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPiPluginUpdateSnapshot,
  PI_PLUGIN_UPDATE_CHECK_INTERVAL_MS,
  piPluginUpdateCacheIsFresh,
  piPluginUpdateCheckDelay,
} from "./piPluginUpdateCheck.js";

const day = PI_PLUGIN_UPDATE_CHECK_INTERVAL_MS;

test("plugin update cache stays fresh for a day", () => {
  assert.equal(piPluginUpdateCacheIsFresh(undefined, 1_000), false);
  assert.equal(piPluginUpdateCacheIsFresh(1_000, 1_000), true);
  assert.equal(piPluginUpdateCacheIsFresh(1_000, 1_000 + day - 1), true);
  assert.equal(piPluginUpdateCacheIsFresh(1_000, 1_000 + day), false);
  assert.equal(piPluginUpdateCacheIsFresh(5_000, 1_000), false);
  assert.equal(piPluginUpdateCheckDelay(1_000, 1_000 + 60_000), day - 60_000);
  assert.equal(piPluginUpdateCheckDelay(undefined, 1_000), 0);
});

test("older plugin update snapshot does not replace a newer one", () => {
  const current = {
    workspaceKey: "proj",
    updates: [{ id: "pkg:user:npm:next" }],
    checkedAt: 2_000,
  };
  assert.equal(
    applyPiPluginUpdateSnapshot(current, {
      workspaceKey: "proj",
      updates: [],
      checkedAt: 1_000,
    }),
    current,
  );
  assert.equal(
    applyPiPluginUpdateSnapshot(current, { workspaceKey: "proj", updates: [] }),
    current,
  );
  const switched = applyPiPluginUpdateSnapshot(current, {
    workspaceKey: "other",
    updates: [],
    checkedAt: 1_000,
  });
  assert.equal(switched.workspaceKey, "other");
});
