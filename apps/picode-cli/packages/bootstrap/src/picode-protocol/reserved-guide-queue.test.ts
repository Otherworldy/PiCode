import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemorySessionEventStore } from "@picode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@picode/core";
import { HostSessionRegistry, type PiSessionPort } from "@picode/pi-host";
import { V4InteractionRegistry } from "../picode-protocol-v4/interaction-registry.js";
import { buildWorkspaceRef } from "./mapper.js";
import { bindHostedSession } from "./pi-session-record.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { createConversationV4Gateway } from "./v4-bridge.js";

for (const reservedDelivery of ["guide", "queue"] as const) {
  test(
    `automatic hosted FIFO ${reservedDelivery === "guide" ? "skips SDK GUIDE" : "holds other reservations"}`,
    { timeout: 5000 },
    async () => {
      const tempRoot = process.platform === "win32" ? "D:/tmp" : tmpdir();
      await mkdir(tempRoot, { recursive: true });
      const root = await mkdtemp(join(tempRoot, "picode-guide-fifo-"));
      const prompts: string[] = [];
      const finished = Promise.withResolvers<void>();
      const pi: PiSessionPort = {
        sessionId: "guide-fifo",
        isStreaming: false,
        isIdle: true,
        async prompt(text) {
          prompts.push(text);
          if (prompts.length === 2) finished.resolve();
          return true;
        },
        waitTurn: () => Promise.resolve(),
        async steer() {},
        async followUp() {},
        async abort() {},
        async compact() {},
        subscribe: () => () => {},
        async dispose() {},
      };
      const registry = new HostSessionRegistry({
        storageRoot: join(root, "meta"),
        nativeSessionsRoot: join(root, "sessions"),
        createSession: async () => pi,
      });
      const context: ZCodeProtocolAgentServerContext = {
        appRuntimePreferences: { modelIoFullRetentionEnabled: false, offPeakToolEnabled: false },
        deps: {
          createZCodeApp() {
            throw new Error("unexpected legacy Core app");
          },
          createSessionEventStore: () => createInMemorySessionEventStore(),
          workspaceHookPolicyProvider: new InMemoryWorkspaceHookPolicyProvider(),
        },
        notify() {},
        async requestClient() {
          throw new Error("unexpected client request");
        },
        sessions: new Map(),
        v4Interactions: new V4InteractionRegistry(),
        piHost: registry,
      };
      const hosted = await registry.create({ sessionId: pi.sessionId, workspacePath: root });
      await bindHostedSession(context, hosted, buildWorkspaceRef({ workspacePath: root }));
      const gateway = createConversationV4Gateway(context);
      context.v4Gateway = gateway;
      try {
        const reserved = {
          ...hosted.queue.createItem({
            sourceCommandId: "reserved",
            clientId: "test",
            text: "retained",
            admitted: reservedDelivery,
          }),
          dispatch: { state: "reserved" as const },
        };
        hosted.queue.enqueue(reserved);
        for (const text of ["ordinary-first", "ordinary-second"]) {
          hosted.queue.enqueue(
            hosted.queue.createItem({
              sourceCommandId: text,
              clientId: "test",
              text,
              admitted: "queue",
            }),
          );
        }
        hosted.queue.autoDrain = false;
        hosted.projector.replaceQueue(hosted.queue.snapshot());
        const subscribed = await gateway.subscribe({
          topic: `conversation/${hosted.sessionId}`,
          connectionId: "fifo",
          clientMode: "desktop-continuous",
        });
        const frame = subscribed.initialFrame;
        assert.ok(frame?.payload.kind === "snapshot");
        const ack = await gateway.handleCommand({
          baseRevision: frame.payload.snapshot.revision,
          baseLogEpoch: frame.payload.snapshot.logEpoch,
          commandId: "resume",
          clientId: "test",
          sessionId: hosted.sessionId,
          type: "setAutoDrain",
          payload: { autoDrain: true },
          issuedAt: 1,
        });
        assert.equal(ack.status, "accepted", JSON.stringify(ack));
        if (reservedDelivery === "guide") await finished.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(
          prompts,
          reservedDelivery === "guide" ? ["ordinary-first", "ordinary-second"] : [],
        );
        assert.equal(hosted.queue.snapshot().items[0], reserved);
        assert.equal(hosted.queue.snapshot().items.length, reservedDelivery === "guide" ? 1 : 3);
        assert.equal(hosted.queue.autoDrain, true);
      } finally {
        gateway.dispose();
        await hosted.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
