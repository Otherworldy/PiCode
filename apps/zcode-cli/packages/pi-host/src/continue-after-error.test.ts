import assert from "node:assert/strict";
import test from "node:test";
import { prepareContinueMessages } from "./continue-after-error.js";

test("continue drops only the failed assistant and keeps the tool result", () => {
  const prepared = prepareContinueMessages([
    { role: "user" },
    { role: "assistant", stopReason: "stop" },
    { role: "toolResult" },
    { role: "assistant", stopReason: "error" },
  ]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(
    prepared.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
});

test("continue refuses a finished assistant reply", () => {
  assert.equal(prepareContinueMessages([{ role: "user" }, { role: "assistant", stopReason: "stop" }]).ok, false);
  assert.equal(prepareContinueMessages([{ role: "system" }]).ok, false);
});
