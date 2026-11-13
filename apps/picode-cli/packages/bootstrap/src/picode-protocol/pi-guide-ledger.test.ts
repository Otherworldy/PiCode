import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInputRecord, SessionStorePort } from "@picode/contracts";
import type { V4GatewayHost } from "../picode-protocol-v4/v4-gateway.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import "./server.js";
import { createConversationV4Gateway } from "./v4-bridge.js";

function fixture() {
  const promotions: unknown[] = [];
  const facts: unknown[] = [];
  const settlements: unknown[] = [];
  let input = {
    id: "queue_guide",
    sessionID: "remote",
    status: "admitted",
    payload: {
      text: "guide",
      conversationInputIntent: { sourceCommandId: "guide", clientId: "phone" },
    },
  } as unknown as SessionInputRecord;
  const store = {
    getSession: async () => ({
      directory: "D:/same-path",
      workspaceID: "remote-workspace-identity",
    }),
    messages: async () => [],
    sessionEntries: async () => facts,
    saveSessionEntry: async (value: unknown) => {
      facts.push(value);
    },
    settleSessionInput: async (value: unknown) => {
      settlements.push(value);
    },
    listSessionInputs: async () => [],
    getSessionInputById: async (id: string) => (id === input.id ? input : null),
    async markSessionInputPromoted(value: {
      id: string;
      sessionID: string;
      promotedMessageID: string;
    }) {
      promotions.push(value);
      if (
        value.id === input.id &&
        value.sessionID === input.sessionID &&
        input.status === "admitted"
      )
        input = {
          ...input,
          status: "promoted",
          promotedMessageID: value.promotedMessageID as SessionInputRecord["promotedMessageID"],
        };
    },
  } as unknown as SessionStorePort;
  const context = {
    deps: { sessionStore: store },
    sessions: new Map(),
    notify() {},
  } as unknown as ZCodeProtocolAgentServerContext;
  const gateway = createConversationV4Gateway(context);
  const host = Reflect.get(gateway, "host") as V4GatewayHost;
  return {
    gateway,
    host,
    promotions,
    facts,
    settlements,
    setInput: (next: SessionInputRecord) => {
      input = next;
    },
    getInput: () => input,
  };
}

test("handled Pi input records accepted command facts without inventing a transcript message", async () => {
  const f = fixture();
  try {
    const ack = { commandId: "guide", status: "accepted" as const, revisionAtDecision: 1 };
    await f.host.completeHandledPiInput?.(
      "remote",
      {
        sourceCommandId: "guide",
        queueItemId: "queue_guide",
        clientId: "phone",
      },
      ack,
    );
    assert.equal(f.promotions.length, 0);
    assert.equal(f.facts.length, 1);
    assert.equal(
      (await f.host.lookupTimelineCommand?.({ sessionId: "remote", commandId: "guide" }))?.status,
      "accepted",
    );
    assert.deepEqual(f.settlements, [
      { id: "queue_guide", sessionID: "remote", status: "cancelled", reason: "input.handled" },
    ]);
  } finally {
    f.gateway.dispose();
  }
});

test("Pi materialization marks the durable admission ID using the actual message ID", async () => {
  const f = fixture();
  try {
    assert.equal(
      await f.host.lookupTranscriptCommand?.({ sessionId: "remote", commandId: "guide" }),
      null,
    );
    assert.equal(typeof f.host.materializePiInput, "function");
    await f.host.materializePiInput?.("remote", {
      sourceCommandId: "guide",
      clientId: "phone",
      messageId: "pi-message",
    });
    assert.deepEqual(f.promotions, [
      { id: "queue_guide", sessionID: "remote", promotedMessageID: "pi-message" },
    ]);
    assert.equal(
      (await f.host.lookupTranscriptCommand?.({ sessionId: "remote", commandId: "guide" }))?.status,
      "accepted",
    );
    assert.equal(
      await f.host.lookupTranscriptCommand?.({ sessionId: "local", commandId: "guide" }),
      null,
    );
    f.host.invalidatePersistentCommandFacts?.("remote");
    assert.equal(
      (await f.host.lookupTranscriptCommand?.({ sessionId: "remote", commandId: "guide" }))?.status,
      "accepted",
    );
  } finally {
    f.gateway.dispose();
  }
});

test("Pi promotion rejects a different client identity and a ledger update that did not commit", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.host.materializePiInput!("remote", {
        sourceCommandId: "guide",
        clientId: "other",
        messageId: "message",
      }),
      /inputIdentityMismatch/,
    );
    await assert.rejects(
      f.host.materializePiInput!("local", {
        sourceCommandId: "guide",
        clientId: "phone",
        messageId: "message",
      }),
      /inputIdentityMismatch/,
    );
    assert.equal(f.promotions.length, 0);
    f.setInput({ ...f.getInput(), status: "cancelled" });
    await assert.rejects(
      f.host.materializePiInput!("remote", {
        sourceCommandId: "guide",
        clientId: "phone",
        messageId: "message",
      }),
      /inputPromotionNotCommitted/,
    );
  } finally {
    f.gateway.dispose();
  }
});

test("Pi ledger lookup requires promoted status and the exact source command identity", async () => {
  const f = fixture();
  try {
    for (const input of [
      f.getInput(),
      { ...f.getInput(), status: "cancelled" },
      {
        ...f.getInput(),
        status: "promoted",
        payload: { text: "guide", conversationInputIntent: { sourceCommandId: "other" } },
      },
    ] as SessionInputRecord[]) {
      f.setInput(input);
      assert.equal(
        await f.host.lookupTranscriptCommand?.({ sessionId: "remote", commandId: "guide" }),
        null,
      );
    }
  } finally {
    f.gateway.dispose();
  }
});
