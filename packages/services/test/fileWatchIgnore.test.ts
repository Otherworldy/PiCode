import assert from "node:assert/strict";
import test from "node:test";
import { isIgnoredWatchPath } from "../src/fileWatcher/fileWatcherService.js";

test("watch ignore matches a path segment, not a substring", () => {
  assert.equal(isIgnoredWatchPath("D:/repo/node_modules/pkg/index.js", ["node_modules"]), true);
  assert.equal(isIgnoredWatchPath("D:\\repo\\node_modules\\pkg\\index.js", ["node_modules"]), true);
  assert.equal(
    isIgnoredWatchPath("D:/repo/src/node_modules_backup/index.js", ["node_modules"]),
    false,
  );
  assert.equal(isIgnoredWatchPath("D:/repo/src/index.js", ["node_modules"]), false);
  assert.equal(isIgnoredWatchPath("D:/repo/src/index.js", []), false);
});
