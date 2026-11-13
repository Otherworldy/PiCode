import assert from "node:assert/strict";
import test from "node:test";
import { bindPiInputIdentity } from "./pi-input-identity.js";

test("missing SDK display mirror does not block steering withdrawal", async () => {
  const messages: Array<{ role: string; content: Array<{ type: "text"; text: string }> }> = [];
  const texts = ["guide text"];
  let queueUpdates = 0;
  const agent = {
    steeringQueue: { messages },
    prompt() {},
    steer(message: (typeof messages)[number]) {
      messages.push(message);
    },
    followUp() {},
  };
  const session = {
    agent,
    async prompt(_text: string, options?: { preflightResult?: (result: never) => void }) {
      options?.preflightResult?.("started" as never);
      agent.steer({ role: "user", content: [{ type: "text", text: "guide text" }] });
    },
    async steer() {},
    async followUp() {},
    _steeringMessages: texts,
    _emitQueueUpdate() {
      queueUpdates++;
    },
  } as unknown as Parameters<typeof bindPiInputIdentity>[0];
  const adapter = bindPiInputIdentity(session);
  await adapter.prompt("guide text", {}, { sourceCommandId: "guide", clientId: "desktop" });

  // 同文的其它 SDK 输入可能先消费展示镜像，实际消息对象仍留在 steering queue。
  texts.splice(0, 1);
  assert.equal(adapter.cancelSteering({ sourceCommandId: "guide", clientId: "desktop" }), true);
  assert.deepEqual(messages, []);
  assert.deepEqual(texts, []);
  assert.equal(queueUpdates, 1);
});
