import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAppDataDir } from "./appDataDir.js";

test("ensureAppDataDir renames a legacy directory once", () => {
  const parent = mkdtempSync(join(tmpdir(), "picode-data-"));
  mkdirSync(join(parent, ".zcode"));
  writeFileSync(join(parent, ".zcode", "marker.txt"), "ok");

  const migrated = ensureAppDataDir(parent);
  assert.equal(migrated, join(parent, ".PiCode"));
  assert.equal(existsSync(join(migrated, "marker.txt")), true);
  assert.equal(existsSync(join(parent, ".zcode")), false);
  assert.equal(ensureAppDataDir(parent), migrated);
});
