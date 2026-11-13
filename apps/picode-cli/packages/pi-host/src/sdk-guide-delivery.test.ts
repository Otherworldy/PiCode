import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ConversationDelta } from "@picode/shared/picode-protocol-v4";
import { readPiJsonl } from "./jsonl-history.js";
import { PiToV4Projector } from "./projector.js";
import { createSdkSessionFactory } from "./session-factory.js";
import { HostSessionRegistry } from "./session-registry.js";

for (const profile of ["continuous", "replayable"] as const) {
  for (const steeringMode of ["one-at-a-time", "all"] as const) {
    test(
      `${profile}/${steeringMode}: real SDK long turn keeps guides until consumption and persists their distinct identities`,
      { timeout: 30_000 },
      async (t) => {
        const tempRoot = process.platform === "win32" ? "D:/tmp" : tmpdir();
        await mkdir(tempRoot, { recursive: true });
        const dir = await mkdtemp(join(tempRoot, "picode-guide-"));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let calls = 0;
        const factory = createSdkSessionFactory({
          agentDir: join(dir, "agent"),
          stream: async function* () {
            calls += 1;
            if (calls <= 65) {
              yield {
                type: "tool_call",
                id: `read-${calls}`,
                name: "read",
                arguments: { path: "hello.txt" },
              };
              yield { type: "done" };
              return;
            }
            if (calls === 66) {
              entered.resolve();
              await release.promise;
            }
            yield { type: "text", text: "done" };
            yield { type: "done" };
          },
        });
        await writeFile(join(dir, "hello.txt"), "fixture");
        const registry = new HostSessionRegistry({
          storageRoot: dir,
          nativeSessionsRoot: join(dir, "sessions"),
          loadExtensions: false,
          profile,
          createSession: factory,
          readTitleSummarySettings: async () => ({ enabled: false }),
          completeTitlePrompt: async () => {
            throw new Error("unexpected title model request");
          },
          completeMemoryPrompt: async () => {
            throw new Error("unexpected memory model request");
          },
        });
        const hosted = await registry.create({ workspacePath: dir });
        t.after(async () => {
          release.resolve();
          await hosted.dispose();
          await rm(dir, { recursive: true, force: true });
        });
        hosted.bridge.syncFollowupMode(steeringMode === "all" ? "guide" : "queue");
        const batches: ConversationDelta[][] = [];
        hosted.onDeltas((deltas) => batches.push(deltas));
        await hosted.bridge.admitSend({
          text: "run a long turn",
          commandId: "initial",
          clientId: "desktop",
          delivery: "startNow",
          streaming: false,
        });
        await entered.promise;
        assert.ok(hosted.projector.getSnapshot().rows.window.length > 60);
        for (const commandId of ["g1", "g2"]) {
          const result = await hosted.bridge.admitSend({
            text: "same input",
            commandId,
            clientId: "desktop",
            delivery: "guide",
            streaming: true,
          });
          assert.equal(result.kind, "steer");
          hosted.projector.replaceQueue(hosted.queue.snapshot());
        }
        assert.deepEqual(
          hosted.projector.getSnapshot().queue.items.map((item) => item.sourceCommandId),
          ["g1", "g2"],
        );
        assert.equal(await hosted.bridge.drainNext(), false);
        release.resolve();
        await hosted.waitTurn();
        const rows = hosted.projector
          .getSnapshot()
          .rows.window.filter((row) => row.kind === "userInput");
        assert.deepEqual(
          rows.map((row) => row.sourceCommandId),
          ["initial", "g1", "g2"],
        );
        assert.deepEqual(
          rows.slice(1).map((row) => row.text),
          ["same input", "same input"],
        );
        assert.equal(hosted.queue.snapshot().items.length, 0);
        assert.equal(hosted.projector.getSnapshot().queue.items.length, 0);
        for (const commandId of ["g1", "g2"]) {
          const batch = batches.find((deltas) =>
            deltas.some(
              (delta) =>
                delta.op === "row.appended" &&
                delta.row.kind === "userInput" &&
                delta.row.sourceCommandId === commandId,
            ),
          );
          assert.ok(
            batch?.some(
              (delta) =>
                delta.op === "state.updated" &&
                delta.patch.queue &&
                !delta.patch.queue.items.some((item) => item.sourceCommandId === commandId),
            ),
          );
        }
        const disk = await readFile(hosted.sessionFile, "utf8");
        const storedUsers = disk
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type === "message" && entry.message.role === "user");
        for (const row of rows) {
          if (row.kind !== "userInput") continue;
          const entry = storedUsers.find(
            (entry) => entry.message.picodeInput?.sourceCommandId === row.sourceCommandId,
          );
          assert.equal(
            row.entityId,
            entry?.id,
            "live user row must adopt the actual persisted tree entry",
          );
          assert.ok(
            batches.some((deltas) =>
              deltas.some(
                (delta) => delta.op === "row.upserted" && delta.row.entityId === entry?.id,
              ),
            ),
          );
        }
        const replay = new PiToV4Projector(hosted.sessionId, "replay", { profile });
        replay.replay(readPiJsonl(disk).events);
        assert.deepEqual(
          replay
            .getSnapshot()
            .rows.window.filter((row) => row.kind === "userInput")
            .map((row) => row.sourceCommandId),
          ["initial", "g1", "g2"],
        );
      },
    );
  }
}
