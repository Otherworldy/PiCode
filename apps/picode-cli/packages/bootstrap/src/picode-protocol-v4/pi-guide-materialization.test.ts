import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationInputIntent, UserInputRow } from "@picode/shared/picode-protocol-v4";
import { ConversationV4Gateway } from "./v4-gateway.js";

function intent(sourceCommandId: string): ConversationInputIntent {
  return {
    sourceCommandId,
    queueItemId: `queue_${sourceCommandId}`,
    clientId: "phone",
    kind: "sendText",
    text: "same text",
    attachments: [],
    delivery: { requested: "guide", admitted: "guide" },
    order: { admissionSeq: 1 },
    steer: { state: "submitting" },
    dispatch: { state: "admitted" },
    admittedAt: 1,
  };
}

function row(sourceCommandId?: string, entityId?: string): UserInputRow {
  return {
    kind: "userInput",
    rowId: 1,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    origin: "realUser",
    text: "extension transformed text",
    clientId: "phone",
    ...(sourceCommandId ? { sourceCommandId } : {}),
    ...(entityId ? { entityId } : {}),
  };
}

async function admit(gateway: ConversationV4Gateway, commandId: string, sessionId = "session") {
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

test("handled input settles durable command facts before releasing its live pin", async () => {
  const completion = Promise.withResolvers<void>();
  let entered = false;
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    emitWireFrame() {},
    admitCommandInput: async (envelope) => intent(envelope.commandId),
    executeCommand: async (envelope) => ({
      type: "inputAccepted",
      delivery: "command",
      inputId: envelope.commandId,
    }),
    completeHandledPiInput: async () => {
      entered = true;
      await completion.promise;
    },
  });
  try {
    const ack = admit(gateway, "handled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered, true);
    assert.equal(gateway.hasResidencyBlockingCommands("session"), true);
    completion.resolve();
    await ack;
    assert.equal(gateway.hasResidencyBlockingCommands("session"), false);
  } finally {
    gateway.dispose();
  }
});

function fixture() {
  const promoted = Promise.withResolvers<void>();
  void promoted.promise.catch(() => {});
  const calls: unknown[] = [];
  const errors: unknown[] = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    emitWireFrame() {},
    executeCommand: async (envelope) => ({
      type: "inputAccepted" as const,
      delivery: "queue" as const,
      inputId: envelope.commandId,
    }),
    admitCommandInput: async (envelope) => intent(envelope.commandId),
    materializePiInput: async (
      sessionId: string,
      input: { sourceCommandId: string; clientId: string; messageId: string },
    ) => {
      calls.push({ sessionId, ...input });
      await promoted.promise;
    },
    invalidatePersistentCommandFacts(sessionId) {
      calls.push({ invalidated: sessionId });
    },
    onError(scope, error) {
      errors.push({ scope, error });
    },
  });
  return { gateway, promoted, calls, errors };
}

test("Pi user row settles the exact command only after durable promotion", async () => {
  const f = fixture();
  try {
    await admit(f.gateway, "first");
    await admit(f.gateway, "second");
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    f.gateway.ingestPiDeltas("session", [{ op: "row.appended", row: row("second", "message-2") }]);
    assert.deepEqual(f.calls, [
      {
        sessionId: "session",
        sourceCommandId: "second",
        clientId: "phone",
        messageId: "message-2",
      },
    ]);
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    f.promoted.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      f.gateway.hasResidencyBlockingCommands("session"),
      true,
      "same-text first command remains pinned",
    );
    f.gateway.ingestPiDeltas("session", [
      { op: "row.upserted", row: { ...row("first", "message-1"), rowId: 2 } },
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), false);
    assert.deepEqual(f.errors, []);
    assert.equal(f.calls.filter((call) => "invalidated" in (call as object)).length, 2);
  } finally {
    f.gateway.dispose();
  }
});

test("ACK, queue disappearance, and unattributed rows cannot settle Pi transcript delivery", async () => {
  const f = fixture();
  try {
    await admit(f.gateway, "guide");
    f.gateway.ingestPiDeltas("session", [
      { op: "state.updated", patch: { queue: { items: [], autoDrain: true } } },
      { op: "row.appended", row: row(undefined, "extension-message") },
      { op: "row.appended", row: { ...row("guide", "row:3"), rowId: 3 } },
      { op: "row.appended", row: { ...row("guide"), rowId: 2 } },
    ]);
    f.promoted.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, []);
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
  } finally {
    f.gateway.dispose();
  }
});

test("failed Pi ledger promotion keeps the live pin and reports the failure", async () => {
  const f = fixture();
  try {
    await admit(f.gateway, "guide");
    f.gateway.ingestPiDeltas("session", [{ op: "row.appended", row: row("guide", "message") }]);
    f.promoted.reject(new Error("ledger unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.gateway.hasResidencyBlockingCommands("session"), true);
    assert.equal(f.errors.length, 1);
  } finally {
    f.gateway.dispose();
  }
});

test("Pi materialization keeps identical command IDs isolated by session", async () => {
  const f = fixture();
  try {
    await admit(f.gateway, "same", "local");
    await admit(f.gateway, "same", "remote");
    f.gateway.ingestPiDeltas("remote", [
      { op: "row.appended", row: row("same", "remote-message") },
    ]);
    f.promoted.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.gateway.hasResidencyBlockingCommands("local"), true);
    assert.equal(f.gateway.hasResidencyBlockingCommands("remote"), false);
  } finally {
    f.gateway.dispose();
  }
});
