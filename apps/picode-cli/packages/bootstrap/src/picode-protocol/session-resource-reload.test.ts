import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInMemorySessionEventStore,
  type SessionEntryInfo,
  type SessionStorePort,
} from "@picode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@picode/core";
import { HostSessionRegistry, type PiHostEvent, type PiSessionPort } from "@picode/pi-host";
import { conversationTopicFrameSchema } from "@picode/shared/picode-protocol-v4";
import { V4InteractionRegistry } from "../picode-protocol-v4/interaction-registry.js";
import { buildWorkspaceRef } from "./mapper.js";
import { bindHostedSession } from "./pi-session-record.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { createConversationV4Gateway } from "./v4-bridge.js";

const TEST_OPTIONS = { timeout: 10_000 };
const RELOAD_BUSY = "guard.sessionReloadBusy";
const RELOAD_FAILED = "fault.command.sessionReloadFailed";
const CLIENT_MODES = ["desktop-continuous", "web-remote-replayable"] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-session-reload-"));
  const listeners = new Set<(event: PiHostEvent) => void>();
  const operations: string[] = [];
  let reloadOperation = async () => {};
  let reloadCalls = 0;
  let commandName = "old-capability";
  const pi: PiSessionPort & { isIdle: boolean; isStreaming: boolean; isCompacting: boolean } = {
    sessionId: "session-resource-reload",
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    currentModel: { providerId: "fixture", modelId: "reload-model" },
    thinkingLevel: "high",
    thoughtLevels: () => ["low", "high"],
    listSlashCommands: () => [
      { name: commandName, source: "extension", description: "Fixture capability", inputHint: "" },
    ],
    async reloadResources() {
      reloadCalls++;
      operations.push("reload:start");
      await reloadOperation();
      commandName = "fresh-capability";
      operations.push("reload:end");
    },
    async prompt(text) {
      operations.push(`prompt:${text}`);
      return true;
    },
    waitTurn: () => Promise.resolve(),
    async steer() {},
    async followUp() {},
    async abort() {},
    async compact() {
      operations.push("compact");
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {},
  };
  const registry = new HostSessionRegistry({
    storageRoot: join(root, "meta"),
    nativeSessionsRoot: join(root, "sessions"),
    createSession: async () => pi,
  });
  const facts = new Map<string, SessionEntryInfo>();
  let sessionEntryReads = 0;
  const store = {
    async getSession() {
      return null;
    },
    async messages() {
      return [];
    },
    async sessionEntries() {
      sessionEntryReads++;
      return [...facts.values()];
    },
    async saveSessionEntry(entry: SessionEntryInfo) {
      facts.set(entry.id, structuredClone(entry));
    },
  } as SessionStorePort;
  const context: ZCodeProtocolAgentServerContext = {
    appRuntimePreferences: { modelIoFullRetentionEnabled: false, offPeakToolEnabled: false },
    deps: {
      createZCodeApp() {
        throw new Error("Resource reload must use the hosted Pi session");
      },
      sessionStore: store,
      createSessionEventStore: () => createInMemorySessionEventStore(),
      workspaceHookPolicyProvider: new InMemoryWorkspaceHookPolicyProvider(),
    },
    notify() {},
    async requestClient() {
      throw new Error("Unexpected client request");
    },
    sessions: new Map(),
    v4Interactions: new V4InteractionRegistry(),
    piHost: registry,
  };
  let gateway = createConversationV4Gateway(context);
  context.v4Gateway = gateway;
  try {
    const workspace = buildWorkspaceRef({
      workspacePath: root,
      workspaceIdentity: "reload-workspace",
    });
    const hosted = await registry.create({ sessionId: pi.sessionId, ...workspace });
    const record = await bindHostedSession(context, hosted, workspace);
    const command = (commandId: string, type = "reloadSession", payload: unknown = {}) => ({
      commandId,
      clientId: "reload-client",
      sessionId: hosted.sessionId,
      type,
      payload,
      issuedAt: 1,
    });
    return {
      pi,
      hosted,
      record,
      registry,
      context,
      store,
      facts,
      get sessionEntryReads() {
        return sessionEntryReads;
      },
      get gateway() {
        return gateway;
      },
      recreateGateway() {
        gateway.dispose();
        gateway = createConversationV4Gateway(context);
        context.v4Gateway = gateway;
      },
      command,
      operations,
      get reloadCalls() {
        return reloadCalls;
      },
      setReload(operation: () => Promise<void>) {
        reloadOperation = operation;
      },
      emit(event: PiHostEvent) {
        for (const listener of listeners) listener(event);
      },
      async close() {
        record.unsubscribe?.();
        gateway.dispose();
        try {
          await hosted.dispose();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    gateway.dispose();
    try {
      await registry.get(pi.sessionId)?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function snapshot(raw: unknown) {
  const frame = conversationTopicFrameSchema.parse(raw);
  assert.ok(frame.payload.kind === "snapshot");
  return frame.payload.snapshot;
}

test("V4 reload preserves subscriptions and identity", TEST_OPTIONS, async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inFlight: Promise<unknown>[] = [];
  try {
    f.hosted.setCollaborationMode("yolo");
    f.hosted.queue.autoDrain = false;
    f.hosted.queue.followupMode = "guide";
    f.emit({ type: "agent_start" });
    f.emit({ type: "agent_end" });
    const subscriptions = [];
    for (const clientMode of CLIENT_MODES) {
      const dispatch = await f.gateway.subscribe({
        topic: `conversation/${f.hosted.sessionId}`,
        connectionId: clientMode,
        clientMode,
      });
      subscriptions.push({
        clientMode,
        dispatch,
        before: structuredClone(snapshot(dispatch.initialFrame)),
      });
    }
    const { sessionId, identity, sessionFile } = f.hosted;
    assert.equal(subscriptions[0].before.logEpoch, subscriptions[1].before.logEpoch);
    f.setReload(async () => {
      entered.resolve();
      await release.promise;
    });
    let settled = 0;
    const envelope = f.command("reload-once");
    const first = f.gateway.handleCommand(envelope).then((ack) => {
      settled++;
      return ack;
    });
    inFlight.push(first);
    void first.finally(() => entered.resolve());
    await entered.promise;
    assert.equal(f.reloadCalls, 1);
    assert.equal(settled, 0, "SDK completion must precede the accepted ACK");
    assert.equal(
      f.hosted.queue.tryAcquireConsumer(),
      undefined,
      "reload must hold the real consumer",
    );
    const duplicate = f.gateway.handleCommand(envelope);
    inFlight.push(duplicate);
    release.resolve();
    const ack = await first;
    assert.equal(ack.status, "accepted", JSON.stringify(ack));
    assert.ok(ack.result?.type === "reloadSession");
    assert.ok(ack.result.slashCommands.some((command) => command.name === "fresh-capability"));
    assert.ok(!ack.result.slashCommands.some((command) => command.name === "old-capability"));
    assert.deepEqual(await duplicate, { ...ack, status: "duplicate" });
    assert.deepEqual(await f.gateway.handleCommand(envelope), { ...ack, status: "duplicate" });
    assert.equal(f.reloadCalls, 1);
    assert.equal(f.registry.get(sessionId), f.hosted);
    assert.equal(f.context.sessions.get(sessionId), f.record);
    assert.equal(f.context.sessions.size, 1);
    assert.equal(f.hosted.sessionId, sessionId);
    assert.equal(f.hosted.identity, identity);
    assert.equal(f.hosted.sessionFile, sessionFile);
    assert.equal(f.hosted.queue.autoDrain, false);
    assert.equal(f.hosted.queue.followupMode, "guide");
    const consumer = f.hosted.queue.tryAcquireConsumer();
    assert.ok(consumer, "completion must release the consumer");
    consumer.release();
    for (const subscription of subscriptions)
      f.gateway.flushNow(subscription.dispatch.ack.subscriptionId);
    // 在同一订阅上发布后续真实 Host 事件，不能靠重订阅掩盖 publisher 被重建。
    f.emit({ type: "agent_start" });
    for (const { clientMode, dispatch, before } of subscriptions) {
      const frame = f.gateway.flushNow(dispatch.ack.subscriptionId);
      assert.ok(frame?.payload.kind === "deltas");
      assert.equal(frame.subscriptionId, dispatch.ack.subscriptionId);
      assert.ok(frame.fromSeq >= before.seq);
      assert.ok(frame.toSeq > frame.fromSeq);
      assert.ok(
        frame.payload.deltas.some(
          (delta) => delta.op === "state.updated" && delta.patch.control?.phase === "running",
        ),
      );
      const resumed = f.gateway.resyncReserved({
        topic: frame.topic,
        connectionId: clientMode,
        subscriptionId: frame.subscriptionId,
        base: { logEpoch: before.logEpoch, seq: frame.toSeq },
        forceSnapshot: true,
      });
      assert.equal(resumed.ack.subscriptionId, dispatch.ack.subscriptionId);
      assert.equal(resumed.ack.logEpoch, before.logEpoch);
      const after = snapshot(resumed.initialFrame);
      assert.equal(after.sessionId, before.sessionId);
      assert.deepEqual(after.config, before.config);
      assert.deepEqual(after.rows.window.slice(0, before.rows.window.length), before.rows.window);
      assert.equal(after.rows.totalCount, before.rows.totalCount + 1);
      resumed.commit();
    }
  } finally {
    release.resolve();
    await Promise.allSettled(inFlight);
    await f.close();
  }
});

for (const next of ["sendText", "compact"] as const) {
  test(`V4 reload serializes concurrent ${next}`, TEST_OPTIONS, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inFlight: Promise<unknown>[] = [];
    try {
      f.setReload(async () => {
        entered.resolve();
        await release.promise;
      });
      const reloading = f.gateway.handleCommand(f.command("reload-pending"));
      inFlight.push(reloading);
      void reloading.finally(() => entered.resolve());
      await entered.promise;
      assert.equal(f.reloadCalls, 1);
      const following = f.gateway.handleCommand(
        f.command("after-reload", next, next === "sendText" ? { text: "after reload" } : {}),
      );
      inFlight.push(following);
      // interaction 应答绕过 session gate，提供明确的网关进度边界，无需定时等待。
      await f.gateway.handleCommand(
        f.command("interaction-checkpoint", "resolveInteraction", {
          interactionId: "no-pending-dialog",
          answer: { optionId: "ok" },
        }),
      );
      assert.deepEqual(f.operations, ["reload:start"]);
      assert.equal(f.hosted.queue.canAutoDrain, false);
      release.resolve();
      assert.equal((await reloading).status, "accepted");
      const ack = await following;
      assert.equal(ack.status, "accepted", JSON.stringify(ack));
      assert.deepEqual(f.operations, [
        "reload:start",
        "reload:end",
        next === "sendText" ? "prompt:after reload" : "compact",
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled(inFlight);
      await f.close();
    }
  });
}

const busyCases: Record<string, (f: Fixture) => (() => void) | void> = {
  "SDK streaming": (f) => void (f.pi.isStreaming = true),
  "SDK compaction": (f) => void (f.pi.isCompacting = true),
  "SDK non-idle": (f) => void (f.pi.isIdle = false),
  "accepted queue": (f) => {
    f.hosted.queue.autoDrain = false;
    f.hosted.queue.enqueue(
      f.hosted.queue.createItem({
        sourceCommandId: "waiting",
        clientId: "reload-client",
        text: "retain queued input",
        admitted: "queue",
      }),
    );
  },
  "pending interaction": (f) => {
    f.emit({
      type: "extension_ui_request",
      id: "reload-dialog",
      method: "select",
      title: "Choose",
      options: ["A", "B"],
    });
  },
  "occupied consumer": (f) => {
    const consumer = f.hosted.queue.tryAcquireConsumer();
    assert.ok(consumer);
    return () => consumer.release();
  },
  "protocol finalization": (f) => void (f.record.residencyFinalizationCount = 1),
  "active command": (f) => void (f.record.activeAbortController = new AbortController()),
};

for (const [reason, makeBusy] of Object.entries(busyCases)) {
  test(`V4 reload rejects ${reason} before any SDK reload`, TEST_OPTIONS, async () => {
    const f = await fixture();
    let cleanup: (() => void) | void = undefined;
    try {
      cleanup = makeBusy(f);
      const queued = structuredClone(f.hosted.queue.snapshot());
      const pending = structuredClone(f.hosted.ui.snapshot());
      const ack = await f.gateway.handleCommand(f.command("reload-busy"));
      assert.equal(ack.status, "failed", JSON.stringify(ack));
      assert.equal(ack.reasonCode, RELOAD_BUSY);
      assert.equal(f.reloadCalls, 0);
      assert.deepEqual(f.operations, []);
      assert.deepEqual(f.hosted.queue.snapshot(), queued);
      assert.deepEqual(f.hosted.ui.snapshot(), pending);
    } finally {
      if (cleanup) cleanup();
      f.record.residencyFinalizationCount = 0;
      f.record.activeAbortController = undefined;
      await f.close();
    }
  });
}

test(
  "V4 reload rejects settled live input even after the Host becomes idle",
  TEST_OPTIONS,
  async () => {
    const f = await fixture();
    try {
      f.record.persistence = "immediate";
      f.context.deps.sessionStore = {
        ...f.store,
        async getSession() {
          return null;
        },
        async messages() {
          return [];
        },
        async saveSessionInput() {},
      } as NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
      const finalized = Promise.withResolvers<void>();
      let finalizationCount = 0;
      Object.defineProperty(f.record, "residencyFinalizationCount", {
        get: () => finalizationCount,
        set(value: number) {
          finalizationCount = value;
          if (value === 0) finalized.resolve();
        },
      });
      const sent = await f.gateway.handleCommand(
        f.command("input-awaiting-materialization", "sendText", { text: "await durable input" }),
      );
      assert.equal(sent.status, "accepted", JSON.stringify(sent));
      await finalized.promise;
      assert.equal(f.record.activeAbortController, undefined);
      assert.equal(f.record.residencyFinalizationCount, 0);
      assert.equal(f.hosted.queue.snapshot().items.length, 0);
      assert.equal(f.hosted.hasResidencyBlockingWork, false);
      assert.equal(f.gateway.hasResidencyBlockingCommands(f.hosted.sessionId), true);
      const ack = await f.gateway.handleCommand(f.command("reload-before-materialization"));
      assert.equal(ack.status, "failed", JSON.stringify(ack));
      assert.equal(ack.reasonCode, RELOAD_BUSY);
      assert.equal(f.reloadCalls, 0);
    } finally {
      await f.close();
    }
  },
);

test("V4 reload failures retain ACK reasons", TEST_OPTIONS, async () => {
  const f = await fixture();
  try {
    f.setReload(async () => {
      throw new Error("Fixture resource discovery failed");
    });
    const envelope = f.command("reload-failure");
    const ack = await f.gateway.handleCommand(envelope);
    assert.equal(ack.status, "failed", JSON.stringify(ack));
    assert.equal(ack.reasonCode, RELOAD_FAILED);
    assert.equal(ack.message, "Fixture resource discovery failed");
    assert.equal(ack.result, undefined);
    assert.deepEqual(await f.gateway.handleCommand(envelope), ack);
    assert.equal(f.reloadCalls, 1);
    const consumer = f.hosted.queue.tryAcquireConsumer();
    assert.ok(consumer, "SDK failure must release the consumer");
    consumer.release();
    f.setReload(async () => {});
    const retried = await f.gateway.handleCommand(f.command("reload-retry"));
    assert.equal(retried.status, "accepted", JSON.stringify(retried));
    assert.equal(retried.result?.type, "reloadSession");
    assert.equal(f.reloadCalls, 2);
  } finally {
    await f.close();
  }
});

for (const terminal of ["success", "SDK failure"] as const) {
  test(`V4 reload waits for durable ${terminal} ACK before settling`, TEST_OPTIONS, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inFlight: Promise<unknown>[] = [];
    try {
      if (terminal === "SDK failure") {
        f.setReload(async () => {
          throw new Error("Persist this SDK failure");
        });
      }
      const save = f.store.saveSessionEntry!;
      f.store.saveSessionEntry = async (entry) => {
        entered.resolve();
        await release.promise;
        await save(entry);
      };
      const envelope = f.command("reload-persist-pending");
      let settled = false;
      const first = f.gateway.handleCommand(envelope).then((ack) => {
        settled = true;
        return ack;
      });
      inFlight.push(first);
      await entered.promise;
      let duplicateSettled = false;
      const duplicate = f.gateway.handleCommand(envelope).then((ack) => {
        duplicateSettled = true;
        return ack;
      });
      const key = { sessionId: f.hosted.sessionId, commandId: envelope.commandId };
      let querySettled = false;
      const query = f.gateway.queryCommands({ commands: [key] }).then((result) => {
        querySettled = true;
        return result;
      });
      inFlight.push(duplicate, query);
      assert.equal(f.gateway.hasResidencyBlockingCommands(f.hosted.sessionId), true);
      assert.throws(() => f.gateway.deactivateSession(f.hosted.sessionId), /pinned/);
      await f.gateway.handleCommand(
        f.command("persistence-checkpoint", "resolveInteraction", {
          interactionId: "no-pending-dialog",
          answer: { optionId: "ok" },
        }),
      );
      assert.equal(settled, false);
      assert.equal(duplicateSettled, false);
      assert.equal(querySettled, false);
      assert.equal(f.facts.size, 0);
      release.resolve();
      const ack = await first;
      assert.equal(ack.status, terminal === "success" ? "accepted" : "failed");
      assert.deepEqual(
        await duplicate,
        terminal === "success" ? { ...ack, status: "duplicate" } : ack,
      );
      assert.deepEqual((await query).results, [{ key, result: ack }]);
      assert.equal(f.facts.size, 1);
      assert.equal(f.reloadCalls, 1);
      assert.equal(f.gateway.hasResidencyBlockingCommands(f.hosted.sessionId), false);
    } finally {
      release.resolve();
      await Promise.allSettled(inFlight);
      await f.close();
    }
  });
}

test(
  "V4 reload persistence errors reject the RPC and release the inbox gate",
  TEST_OPTIONS,
  async () => {
    const f = await fixture();
    try {
      const save = f.store.saveSessionEntry!;
      f.store.saveSessionEntry = async () => {
        throw new Error("Fixture command fact storage failed");
      };
      await assert.rejects(
        f.gateway.handleCommand(f.command("reload-storage-failure")),
        /Fixture command fact storage failed/,
      );
      assert.equal(f.reloadCalls, 1);
      assert.equal(f.facts.size, 0);
      assert.equal(f.gateway.hasResidencyBlockingCommands(f.hosted.sessionId), false);
      f.store.saveSessionEntry = save;
      const ack = await f.gateway.handleCommand(f.command("reload-after-storage-recovery"));
      assert.equal(ack.status, "accepted");
      assert.equal(f.reloadCalls, 2);
      assert.equal(f.facts.size, 1);
    } finally {
      await f.close();
    }
  },
);

test("V4 reload requires both command-fact write and read support", TEST_OPTIONS, async () => {
  const f = await fixture();
  try {
    const saveSessionEntry = f.store.saveSessionEntry;
    const sessionEntries = f.store.sessionEntries;
    for (const unavailable of ["write", "read"] as const) {
      f.store.saveSessionEntry = unavailable === "write" ? undefined : saveSessionEntry;
      f.store.sessionEntries = unavailable === "read" ? undefined : sessionEntries;
      await assert.rejects(
        f.gateway.handleCommand(f.command(`reload-${unavailable}-unavailable`)),
        /fault.command.persistentFactStoreUnavailable/,
      );
      assert.equal(f.reloadCalls, unavailable === "write" ? 1 : 2);
      assert.equal(f.facts.size, 0);
      assert.equal(f.gateway.hasResidencyBlockingCommands(f.hosted.sessionId), false);
    }
    f.store.saveSessionEntry = saveSessionEntry;
    f.store.sessionEntries = sessionEntries;
    const recovered = await f.gateway.handleCommand(f.command("reload-readback-restored"));
    assert.equal(recovered.status, "accepted");
    assert.equal(f.reloadCalls, 3);
    assert.equal(f.facts.size, 1);
  } finally {
    await f.close();
  }
});

test("V4 reload recovers terminal ACK after gateway recreation", TEST_OPTIONS, async () => {
  const f = await fixture();
  try {
    const terminal = f.command("durable-reload");
    const ack = await f.gateway.handleCommand(terminal);
    assert.equal(ack.status, "accepted");
    const reloadCalls = f.reloadCalls;
    f.recreateGateway();
    const readsBeforeRecovery = f.sessionEntryReads;
    const key = { sessionId: f.hosted.sessionId, commandId: terminal.commandId };
    const query = await f.gateway.queryCommands({ commands: [key] });
    assert.equal(
      f.sessionEntryReads,
      readsBeforeRecovery + 1,
      "recovery must reload facts from storage",
    );
    assert.deepEqual(query.results, [{ key, result: ack }]);
    assert.deepEqual(await f.gateway.handleCommand(terminal), { ...ack, status: "duplicate" });
    assert.equal(f.reloadCalls, reloadCalls, "durable ACK must prevent a second SDK reload");
    assert.equal(f.facts.size, 1);
    assert.deepEqual([...f.facts.values()][0].data, { source: "timeline", ack });
  } finally {
    await f.close();
  }
});

for (const terminal of ["SDK failure", "busy"] as const) {
  test(`V4 reload recovers ${terminal} ACK after gateway recreation`, TEST_OPTIONS, async () => {
    const f = await fixture();
    try {
      if (terminal === "SDK failure") {
        f.setReload(async () => {
          throw new Error("Durable SDK failure reason");
        });
      }
      if (terminal === "busy") f.pi.isStreaming = true;
      const envelope = f.command("durable-reload");
      const ack = await f.gateway.handleCommand(envelope);
      assert.equal(ack.status, "failed");
      assert.equal(ack.reasonCode, terminal === "busy" ? RELOAD_BUSY : RELOAD_FAILED);
      const reloadCalls = f.reloadCalls;
      f.recreateGateway();
      const readsBeforeRecovery = f.sessionEntryReads;
      const key = { sessionId: f.hosted.sessionId, commandId: envelope.commandId };
      const query = await f.gateway.queryCommands({ commands: [key] });
      assert.equal(
        f.sessionEntryReads,
        readsBeforeRecovery + 1,
        "recovery must reload facts from storage",
      );
      assert.deepEqual(query.results, [{ key, result: ack }]);
      assert.deepEqual(await f.gateway.handleCommand(envelope), ack);
      assert.equal(f.reloadCalls, reloadCalls, "durable ACK must prevent a second SDK reload");
      assert.equal(f.facts.size, 1);
      assert.deepEqual([...f.facts.values()][0].data, { source: "timeline", ack });
    } finally {
      await f.close();
    }
  });
}

test("V4 reload rejects invalid payloads before the SDK", TEST_OPTIONS, async () => {
  const f = await fixture();
  try {
    for (const [index, payload] of [{ force: true }, null].entries()) {
      const ack = await f.gateway.handleCommand(
        f.command(`invalid-reload-${index}`, "reloadSession", payload),
      );
      assert.equal(ack.status, "rejected");
      assert.equal(ack.reasonCode, "proto.invalidPayload");
    }
    assert.equal(f.reloadCalls, 0);
  } finally {
    await f.close();
  }
});
