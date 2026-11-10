import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_SUBAGENT_NAMES } from "@zcode/shared";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";
import {
  isBuiltInSubagentName,
  subagentDisplayName,
  subagentDisplayTitle,
} from "./subagentDisplayName.js";

/** 与 `createIntl` 同口径：缺 key 时原样返回 id，这正是回退逻辑要防的情况。 */
function formatterFor(messages: Record<string, string>) {
  return ({ id }: { id: string }) => messages[id] ?? id;
}

const zh = formatterFor(zhCN);
const en = formatterFor(enUS);

test("translates built-in role names for the current locale", () => {
  assert.equal(subagentDisplayName("worker", zh), "实现");
  assert.equal(subagentDisplayName("evidence-auditor", zh), "证据核对");
  assert.equal(subagentDisplayName("worker", en), "worker");
});

test("leaves names that are not built-in roles untouched", () => {
  // 用户自建、插件角色和宿主兜底值都没有词条：名字是人给的，原样显示。
  assert.equal(subagentDisplayName("my-helper", zh), "my-helper");
  assert.equal(subagentDisplayName("subagent", zh), "subagent");
  assert.equal(subagentDisplayName("plugin:reviewer", zh), "plugin:reviewer");
});

test("trims the wire name before matching", () => {
  assert.equal(subagentDisplayName("  scout  ", zh), "侦察");
  assert.equal(subagentDisplayName("   ", zh), "");
});

test("falls back to the wire name when a built-in role has no message", () => {
  // 少配一条词条不能让界面打出 `subagent.builtin.worker`。
  assert.equal(subagentDisplayName("worker", formatterFor({})), "worker");
});

test("translates a title only when it is exactly a built-in role name", () => {
  // 宿主在子会话没有标题时拿角色名兜底，这条兜底值要跟着语言走。
  assert.equal(subagentDisplayTitle("scout", zh), "侦察");
  // 任务标题是自由文本，不做词条匹配。
  assert.equal(subagentDisplayTitle("修复 worker 的重试逻辑", zh), "修复 worker 的重试逻辑");
  assert.equal(subagentDisplayTitle("", zh), "");
});

test("every built-in role has a message in both locales", () => {
  // 角色清单与 locale 是两份数据，没有测试就会一边加角色、另一边忘词条。
  for (const name of BUILT_IN_SUBAGENT_NAMES) {
    assert.equal(isBuiltInSubagentName(name), true);
    const id = `subagent.builtin.${name}`;
    assert.ok(zhCN[id], `zh-CN 缺少 ${id}`);
    assert.ok(enUS[id], `en-US 缺少 ${id}`);
  }
});
