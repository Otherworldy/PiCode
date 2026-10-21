import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";
import { isSubagentDispatchToolCall, readSubagentDispatchRole } from "./subagentToolNames.js";

test("recognizes picode_subagent from toolName, kind and raw wire names", () => {
  assert.equal(isSubagentDispatchToolCall({ kind: "picode_subagent" }), true);
  assert.equal(isSubagentDispatchToolCall({ toolName: "PicodeSubagent" }), true);
  assert.equal(isSubagentDispatchToolCall({ raw: { tool_name: "picode_subagent" } }), true);
});

test("leaves agent tools and unrelated names on their own renderer", () => {
  assert.equal(isSubagentDispatchToolCall({ kind: "Agent", title: "Subagent" }), false);
  assert.equal(isSubagentDispatchToolCall({ kind: "picode_subagent_extra" }), false);
  assert.equal(isSubagentDispatchToolCall({}), false);
});

// 摘要行与分享页都按这个 key 取文案；`formatMessage` 缺 key 时会原样打出 key，
// 所以拼错或只加了一边 locale 不会有其它测试报错。
test("both locales label the dispatch tool", () => {
  assert.equal(zhCN["chat.toolCall.kind.subagent"], "子智能体");
  assert.equal(enUS["chat.toolCall.kind.subagent"], "SubAgent");
});

test("reads the dispatched role from object or streaming-JSON input", () => {
  assert.equal(readSubagentDispatchRole({ input: { agent: " reviewer ", task: "x" } }), "reviewer");
  const fullInput = JSON.stringify({ agent: "scout", task: "x" });
  assert.equal(readSubagentDispatchRole({ input: fullInput }), "scout");
  // 半截 JSON、缺字段或空角色名时不猜角色，摘要行保持只有「子智能体」。
  assert.equal(readSubagentDispatchRole({ input: fullInput.slice(0, -5) }), undefined);
  assert.equal(readSubagentDispatchRole({ input: { task: "x" } }), undefined);
  assert.equal(readSubagentDispatchRole({ input: { agent: "   " } }), undefined);
  assert.equal(readSubagentDispatchRole({}), undefined);
});
