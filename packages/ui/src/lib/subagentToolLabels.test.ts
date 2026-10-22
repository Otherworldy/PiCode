import assert from "node:assert/strict";
import test from "node:test";
import { mergeSubagentToolOptions, subagentToolLabel } from "./subagentToolLabels.js";

test("runtime catalog wins, then role defaults and current selection keep stale names visible", () => {
  assert.deepEqual(
    mergeSubagentToolOptions(
      ["read", "one_search", "custom_lookup"],
      ["read", "write", "one_search"],
      ["removed_tool"],
      ["read"],
    ),
    ["read", "one_search", "custom_lookup", "write", "removed_tool"],
  );
});

test("empty and whitespace entries are dropped", () => {
  assert.deepEqual(mergeSubagentToolOptions(["", "  "], ["read"], undefined), ["read"]);
});

test("known tools get the same labels as the user-agent tool card", () => {
  assert.equal(subagentToolLabel("read"), "Read");
  assert.equal(subagentToolLabel("one_search"), "WebSearch");
  assert.equal(subagentToolLabel("web_fetch"), "WebFetch");
  // 扩展工具没有固定译名时保持原名。
  assert.equal(subagentToolLabel("custom_lookup"), "custom_lookup");
});
