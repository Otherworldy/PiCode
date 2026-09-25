import assert from "node:assert/strict";
import test from "node:test";
import { readUnknownToolResult, summarizeUnknownToolInput } from "./fallback-summary.js";

test("unknown tool summary prefers the search pattern over the path", () => {
  assert.equal(
    summarizeUnknownToolInput({
      pattern: "AI分析助手",
      path: "D:/Study/Code/Node/Projects/stock_new",
    }),
    "AI分析助手",
  );
});

test("unknown tool result keeps text and does not rewrap a string", () => {
  assert.equal(readUnknownToolResult("front-build/dist/a.js\n1: title"), "front-build/dist/a.js\n1: title");
  assert.equal(readUnknownToolResult({ text: "ok" }), "ok");
});
