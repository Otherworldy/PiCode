import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSdkSessionFactory, HostSessionRegistry } from "@picode/pi-host";
import { ConversationV4Gateway } from "../picode-protocol-v4/v4-gateway.js";

test(
  "real SDK append failure leaves a consumed input pinned in the gateway",
  { timeout: 20_000 },
  async () => {
    const root = process.platform === "win32" ? "D:/tmp" : tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "picode-guide-write-failure-"));
    const registry = new HostSessionRegistry({
      storageRoot: dir,
      nativeSessionsRoot: join(dir, "sessions"),
      loadExtensions: false,
      readTitleSummarySettings: async () => ({ enabled: false }),
      createSession: createSdkSessionFactory({
        agentDir: join(dir, "agent"),
        stream: async function* () {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        },
      }),
    });
    const hosted = await registry.create({ workspacePath: dir });
    const materialized: string[] = [];
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      emitWireFrame() {},
      admitCommandInput: async (envelope) => ({
        sourceCommandId: envelope.commandId,
        queueItemId: `queue_${envelope.commandId}`,
        clientId: envelope.clientId,
        kind: "sendText",
        text: "cannot persist",
        attachments: [],
        delivery: { requested: "guide", admitted: "guide" },
        order: { admissionSeq: 1 },
        steer: { state: "submitting" },
        dispatch: { state: "admitted" },
        admittedAt: 1,
      }),
      executeCommand: async (envelope) => {
        const result = await hosted.bridge.admitSend({
          text: "cannot persist",
          commandId: envelope.commandId,
          clientId: envelope.clientId,
          delivery: "guide",
          streaming: false,
        });
        assert.equal(result.kind, "prompt");
        return { type: "inputAccepted", delivery: "startNow", inputId: envelope.commandId };
      },
      materializePiInput: async (_sessionId, input) => {
        materialized.push(input.sourceCommandId);
      },
    });
    try {
      await hosted.bridge.admitSend({
        text: "initial",
        commandId: "initial",
        clientId: "desktop",
        delivery: "startNow",
        streaming: false,
      });
      await hosted.waitTurn();
      await rm(hosted.sessionFile);
      await mkdir(hosted.sessionFile);
      hosted.onDeltas((deltas) => gateway.ingestPiDeltas(hosted.sessionId, deltas));
      const ack = await gateway.handleCommand({
        commandId: "write-failed",
        clientId: "desktop",
        sessionId: hosted.sessionId,
        type: "sendText",
        payload: { text: "cannot persist", requestedDelivery: "guide" },
        issuedAt: 1,
      });
      assert.equal(ack.status, "accepted");
      await hosted.waitTurn();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const row = hosted.projector
        .getSnapshot()
        .rows.window.find(
          (row) => row.kind === "userInput" && row.sourceCommandId === "write-failed",
        );
      assert.ok(row, "the SDK consumed the attributed input before its failed append");
      assert.equal(materialized.includes("write-failed"), false);
      assert.equal(gateway.hasResidencyBlockingCommands(hosted.sessionId), true);
    } finally {
      gateway.dispose();
      await hosted.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
