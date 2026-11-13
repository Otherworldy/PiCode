import assert from "node:assert/strict";
import test from "node:test";
import { commandResultSchema, parseCommandEnvelope } from "./command.js";

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    commandId: "cmd-1",
    clientId: "test",
    sessionId: "session-1",
    type,
    payload,
    issuedAt: Date.now(),
    ...extra,
  };
}

test("reloadSession 使用严格空 payload，不要求 CAS", () => {
  assert.equal(parseCommandEnvelope(envelope("reloadSession", {})).ok, true);
  assert.equal(parseCommandEnvelope(envelope("reloadSession", { force: true })).ok, false);
  assert.equal(parseCommandEnvelope(envelope("reloadSession", null)).ok, false);
});

test("reloadSession 成功结果包含当前命令目录", () => {
  assert.equal(
    commandResultSchema.safeParse({
      type: "reloadSession",
      slashCommands: [{ name: "probe", description: "Reloaded extension", source: "extension" }],
    }).success,
    true,
  );
  assert.equal(
    commandResultSchema.safeParse({ type: "reloadSession", slashCommands: [{ name: "" }] }).success,
    false,
  );
});

// 模型切换是 last-write-wins：turn 进行中 conversation revision 会随 control/row.* 前进，
// 要求 baseRevision 精确匹配只会把用户的切换意图按 stale 丢掉
// （见 docs/specs/model-switch-runtime-ownership.md）。
test("switchModelConfig 不再要求 baseRevision", () => {
  const parsed = parseCommandEnvelope(
    envelope("switchModelConfig", { provider: "p", model: "m", thought: "" }),
  );
  assert.equal(parsed.ok, true);
});

test("switchModelConfig 仍校验 payload", () => {
  const parsed = parseCommandEnvelope(envelope("switchModelConfig", { provider: "p" }));
  assert.equal(parsed.ok, false);
});

test("真正的 CAS 命令仍要求 baseRevision", () => {
  const parsed = parseCommandEnvelope(envelope("switchCollaborationMode", { mode: "build" }));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.ok === false ? parsed.error.issues[0]?.path : undefined, [
    "baseRevision",
  ]);
});
