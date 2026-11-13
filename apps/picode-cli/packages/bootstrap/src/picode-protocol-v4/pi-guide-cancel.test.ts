import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationInputIntent } from "@picode/shared/picode-protocol-v4";
import { ConversationV4Gateway } from "./v4-gateway.js";

function intent(sourceCommandId: string, clientId = "phone"): ConversationInputIntent {
  return {
    sourceCommandId,
    queueItemId: `queue_${sourceCommandId}`,
    clientId,
    kind: "sendText",
    text: "same text",
    attachments: [],
    delivery: { requested: "guide", admitted: "guide" },
    order: { admissionSeq: 1 },
    steer: { state: "steering" },
    dispatch: { state: "admitted" },
    admittedAt: 1,
  };
}

type GuideIdentity = { sourceCommandId: string; clientId: string };

function fixture(
  onCancel?: (sessionId: string, input: GuideIdentity) => Promise<void> | void,
  options: { withLedger?: boolean } = {},
) {
  const events: string[] = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    emitWireFrame() {},
    admitCommandInput: async (envelope) => intent(envelope.commandId, envelope.clientId || "phone"),
    executeCommand: async (envelope) => ({
      type: "inputAccepted" as const,
      delivery: "queue" as const,
      inputId: envelope.commandId,
    }),
    ...(options.withLedger === false
      ? {}
      : {
          async cancelPendingGuideInput(sessionId: string, input: GuideIdentity) {
            events.push(`durable:${sessionId}:${input.sourceCommandId}:${input.clientId}`);
            // 账本写盘期间 live pin 必须仍在，durable 成功后才允许解除。
            assert.equal(gateway.hasResidencyBlockingCommands(sessionId), true);
            await onCancel?.(sessionId, input);
          },
        }),
    invalidatePersistentCommandFacts: (sessionId) => events.push(`invalidate:${sessionId}`),
  });
  return { gateway, events };
}

async function admit(
  gateway: ConversationV4Gateway,
  commandId: string,
  sessionId = "session",
): Promise<void> {
  const ack = await gateway.handleCommand({
    commandId,
    clientId: "phone",
    sessionId,
    issuedAt: 1,
    type: "sendText",
    payload: { text: "same text", requestedDelivery: "guide" },
  });
  assert.equal(ack.status, "accepted");
}

test("cancelling a pending guide settles its ledger before releasing exactly that pin", async () => {
  const f = fixture();
  try {
    await admit(f.gateway, "first");
    await admit(f.gateway, "second");
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    await f.gateway.cancelPendingGuideInput("session", {
      sourceCommandId: "first",
      clientId: "phone",
    });
    assert.deepEqual(f.events, ["durable:session:first:phone", "invalidate:session"]);
    // 同文另一条 GUIDE 仍被 pin 保护：只能收口指定 sourceCommandId。
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    await f.gateway.cancelPendingGuideInput("session", {
      sourceCommandId: "second",
      clientId: "phone",
    });
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), false);
  } finally {
    f.gateway.dispose();
  }
});

test("durable cancellation failure keeps the live pin and skips cache invalidation", async () => {
  const failure = Object.assign(new Error("fault.command.inputCancellationNotCommitted"), {
    reasonCode: "fault.command.inputCancellationNotCommitted",
  });
  let attempts = 0;
  const f = fixture(() => {
    if (attempts++ === 0) throw failure;
  });
  try {
    await admit(f.gateway, "guide");
    await assert.rejects(
      f.gateway.cancelPendingGuideInput("session", {
        sourceCommandId: "guide",
        clientId: "phone",
      }),
      { reasonCode: "fault.command.inputCancellationNotCommitted" },
    );
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    assert.deepEqual(f.events, ["durable:session:guide:phone"]);
    await f.gateway.cancelPendingGuideInput("session", {
      sourceCommandId: "guide",
      clientId: "phone",
    });
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), false);
    assert.deepEqual(f.events, [
      "durable:session:guide:phone",
      "durable:session:guide:phone",
      "invalidate:session",
    ]);
  } finally {
    f.gateway.dispose();
  }
});

test("guide cancellation identity mismatch is reported without releasing the pin", async () => {
  const f = fixture((_sessionId, input) => {
    if (input.clientId !== "phone") {
      throw Object.assign(new Error("fault.command.inputIdentityMismatch"), {
        reasonCode: "fault.command.inputIdentityMismatch",
      });
    }
  });
  try {
    await admit(f.gateway, "guide");
    await assert.rejects(
      f.gateway.cancelPendingGuideInput("session", {
        sourceCommandId: "guide",
        clientId: "other",
      }),
      { reasonCode: "fault.command.inputIdentityMismatch" },
    );
    // 身份不符时以调用方给出的身份为准核对，不能按队列/会话状态猜测。
    assert.deepEqual(f.events, ["durable:session:guide:other"]);
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    await f.gateway.cancelPendingGuideInput("session", {
      sourceCommandId: "guide",
      clientId: "phone",
    });
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), false);
  } finally {
    f.gateway.dispose();
  }
});

test("guide cancellation without a durable ledger capability fails and keeps the pin", async () => {
  const f = fixture(undefined, { withLedger: false });
  try {
    await admit(f.gateway, "guide");
    await assert.rejects(
      f.gateway.cancelPendingGuideInput("session", {
        sourceCommandId: "guide",
        clientId: "phone",
      }),
      /inputSettlementUnavailable/,
    );
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    assert.deepEqual(f.events, []);
  } finally {
    f.gateway.dispose();
  }
});
