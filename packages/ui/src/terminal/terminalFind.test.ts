import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTerminalFindCount,
  shouldOpenTerminalFind,
  terminalSearchOptions,
} from "./terminalFind.js";

test("task find shortcut opens terminal find only while focus is inside a terminal session", () => {
  assert.equal(shouldOpenTerminalFind("findInTask", true), true);
  assert.equal(shouldOpenTerminalFind("findInTask", false), false);
  assert.equal(shouldOpenTerminalFind("toggleTerminal", true), false);
});

test("terminal find count stays idle for an empty query and reports matches from 1", () => {
  assert.deepEqual(formatTerminalFindCount("", { resultIndex: 0, resultCount: 2 }), {
    kind: "idle",
  });
  assert.deepEqual(formatTerminalFindCount("ls", null), { kind: "none" });
  assert.deepEqual(formatTerminalFindCount("ls", { resultIndex: 0, resultCount: 0 }), {
    kind: "none",
  });
  assert.deepEqual(formatTerminalFindCount("ls", { resultIndex: -1, resultCount: 1000 }), {
    kind: "overflow",
    total: 1000,
  });
  assert.deepEqual(formatTerminalFindCount("ls", { resultIndex: 0, resultCount: 3 }), {
    kind: "match",
    current: 1,
    total: 3,
  });
});

test("terminal search decorations use hex colors xterm can paint", () => {
  const options = terminalSearchOptions(true, false);
  assert.equal(options.caseSensitive, true);
  assert.equal(options.incremental, false);
  for (const color of Object.values(options.decorations ?? {})) {
    assert.match(color, /^#[0-9a-f]{6}$/i);
  }
});
