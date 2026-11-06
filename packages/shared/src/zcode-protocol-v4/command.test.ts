import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandEnvelope } from "./command.js";

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
  assert.deepEqual(
    parsed.ok === false ? parsed.error.issues[0]?.path : undefined,
    ["baseRevision"],
  );
});
