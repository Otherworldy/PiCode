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
      const settlement = value as {
        id: string;
        sessionID: string;
        status: SessionInputRecord["status"];
        reason?: string;
      };
      // 与真实账本一致：只有 admitted 能收口，且收口后状态必须可被重读确认。
      if (
        settlement.id === input.id &&
        settlement.sessionID === input.sessionID &&
        input.status === "admitted"
      )
        input = { ...input, status: settlement.status, statusReason: settlement.reason };
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
    store,
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

test("handled Pi input requires readable and writable command facts before settling admission", async () => {
  const f = fixture();
  try {
    const saveSessionEntry = f.store.saveSessionEntry;
    const sessionEntries = f.store.sessionEntries;
    const ack = { commandId: "guide", status: "accepted" as const, revisionAtDecision: 1 };
    for (const unavailable of ["write", "read"] as const) {
      f.store.saveSessionEntry = unavailable === "write" ? undefined : saveSessionEntry;
      f.store.sessionEntries = unavailable === "read" ? undefined : sessionEntries;
      await assert.rejects(
        f.host.completeHandledPiInput!(
          "remote",
          {
            sourceCommandId: "guide",
            queueItemId: "queue_guide",
            clientId: "phone",
          },
          ack,
        ),
        /fault.command.persistentFactStoreUnavailable/,
      );
      assert.deepEqual(f.facts, []);
      assert.deepEqual(f.settlements, []);
      assert.equal(f.getInput().status, "admitted");
    }
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

test("cancelled pending guide settles the exact durable admission ID", async () => {
  const f = fixture();
  try {
    await f.host.cancelPendingGuideInput?.("remote", {
      sourceCommandId: "guide",
      clientId: "phone",
    });
    assert.deepEqual(f.settlements, [
      {
        id: "queue_guide",
        sessionID: "remote",
        status: "cancelled",
        reason: "input.cancelled",
      },
    ]);
    assert.equal(f.getInput().status, "cancelled");
  } finally {
    f.gateway.dispose();
  }
});

test("cancelled pending guide rejects a different session or client identity", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.host.cancelPendingGuideInput!("remote", { sourceCommandId: "guide", clientId: "other" }),
      /inputIdentityMismatch/,
    );
    await assert.rejects(
      f.host.cancelPendingGuideInput!("local", { sourceCommandId: "guide", clientId: "phone" }),
      /inputIdentityMismatch/,
    );
    await assert.rejects(
      f.host.cancelPendingGuideInput!("remote", { sourceCommandId: "other", clientId: "phone" }),
      /inputIdentityMismatch/,
    );
    assert.deepEqual(f.settlements, []);
    assert.equal(f.getInput().status, "admitted");
  } finally {
    f.gateway.dispose();
  }
});

test("cancelled pending guide requires the durable settlement to commit", async () => {
  const f = fixture();
  try {
    // 已被 SDK 消费并落盘：迟到取消不能把 promoted 回退，必须如实报错。
    f.setInput({ ...f.getInput(), status: "promoted" });
    await assert.rejects(
      f.host.cancelPendingGuideInput!("remote", { sourceCommandId: "guide", clientId: "phone" }),
      /inputCancellationNotCommitted/,
    );
    assert.equal(f.getInput().status, "promoted");
  } finally {
    f.gateway.dispose();
  }
});
