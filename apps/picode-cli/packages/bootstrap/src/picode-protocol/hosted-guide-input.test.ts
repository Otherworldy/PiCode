import assert from "node:assert/strict";
import test from "node:test";
import type { HostedSession } from "@picode/pi-host";
import type { QueueItem } from "@picode/shared/picode-protocol-v4";
import { sendHostedInput } from "./hosted-input.js";
import "./server.js";
import { queueHandlers } from "../picode-protocol-v4/commands/handlers/queue.js";
import type { V4SessionRecordView } from "../picode-protocol-v4/commands/types.js";

function guideItem(): QueueItem {
  return {
    queueItemId: "guide-command",
    sourceCommandId: "guide-command",
    clientId: "desktop",
    kind: "sendText",
    text: "guide",
    attachments: [],
    delivery: { requested: "guide", admitted: "guide" },
    order: { admissionSeq: 1 },
    steer: { state: "steering" },
    dispatch: { state: "reserved" },
    admittedAt: 1,
  };
}

for (const kind of ["steer", "queued", "prompt", "handled"] as const) {
  test(`hosted ${kind} preserves the actual SDK admission`, async () => {
    const item = guideItem();
    let waits = 0;
    let queueUpdates = 0;
    let forwardedClientId: unknown;
    const completion = Promise.resolve();
    const hosted = {
      isIdle: false,
      bridge: {
        admitSend: async (input: { clientId: string }) => {
          forwardedClientId = input.clientId;
          return { kind, queueItemId: item.queueItemId };
        },
      },
      queue: { snapshot: () => ({ items: [item], autoDrain: true }) },
      projector: {
        getSnapshot: () => ({ control: { phase: "running" } }),
        replaceQueue() {
          queueUpdates++;
        },
      },
      waitTurn() {
        waits++;
        return completion;
      },
    } as unknown as HostedSession;
    const admission = await sendHostedInput(hosted, {
      text: "guide",
      inputId: item.sourceCommandId,
      clientId: "desktop",
      delivery: "guide",
    });
    assert.equal(queueUpdates, 1);
    assert.equal(forwardedClientId, "desktop");
    if (kind === "steer" || kind === "queued") {
      assert.deepEqual(admission, {
        kind: "queued",
        pendingInputId: item.queueItemId,
        queueLength: 1,
      });
      assert.equal(waits, 0);
    } else if (kind === "handled") {
      assert.equal(admission.kind, "handled");
      assert.equal(waits, 0);
    } else {
      assert.deepEqual(admission, { kind: "started_turn", completion });
      assert.equal(waits, 1);
    }
  });
}

test("manual promotion rejects an SDK-owned guide before acquiring a consumer or preempting", async () => {
  const item = guideItem();
  let consumerAcquisitions = 0;
  const record = {
    hosted: {
      sessionId: "session",
      queue: {
        snapshot: () => ({ items: [item], autoDrain: true }),
        tryAcquireConsumer() {
          consumerAcquisitions++;
          throw new Error("must not reach consumer/preempt");
        },
      },
    },
  } as unknown as V4SessionRecordView;
  await assert.rejects(
    queueHandlers.sendQueuedNow(
      { getRecord: () => record },
      {
        commandId: "promote",
        clientId: "desktop",
        sessionId: "session",
        type: "sendQueuedNow",
        payload: { queueItemId: item.queueItemId },
        issuedAt: 1,
      },
    ),
    { reasonCode: "guard.queueItemReserved" },
  );
  assert.equal(consumerAcquisitions, 0);
});
