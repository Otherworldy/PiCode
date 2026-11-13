import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSdkSessionFactory } from "./session-factory.js";
import { HostSessionRegistry } from "./session-registry.js";

for (const outcome of ["error", "abort"] as const) {
  test(
    `real SDK ${outcome} preserves a guide through settlement until SDK consumption`,
    { timeout: 20_000 },
    async (t) => {
      const tempRoot = process.platform === "win32" ? "D:/tmp" : tmpdir();
      await mkdir(tempRoot, { recursive: true });
      const dir = await mkdtemp(join(tempRoot, "picode-guide-settlement-"));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const submitted: string[] = [];
      const sdkFactory = createSdkSessionFactory({
        agentDir: join(dir, "agent"),
        stream: async function* () {
          calls++;
          if (calls === 1) {
            entered.resolve();
            await release.promise;
            if (outcome === "error") {
              yield { type: "error", error: "guide fixture failure" };
              return;
            }
          }
          yield { type: "text", text: "done" };
          yield { type: "done" };
        },
      });
      const registry = new HostSessionRegistry({
        storageRoot: dir,
        nativeSessionsRoot: join(dir, "sessions"),
        loadExtensions: false,
        readTitleSummarySettings: async () => ({ enabled: false }),
        completeTitlePrompt: async () => {
          throw new Error("unexpected title model request");
        },
        completeMemoryPrompt: async () => {
          throw new Error("unexpected memory model request");
        },
        createSession: async (input) => {
          const session = await sdkFactory(input);
          const prompt = session.prompt.bind(session);
          session.prompt = (text, options) => {
            submitted.push(text);
            return prompt(text, options);
          };
          return session;
        },
      });
      const hosted = await registry.create({ workspacePath: dir });
      t.after(async () => {
        release.resolve();
        await hosted.dispose();
        await rm(dir, { recursive: true, force: true });
      });
      let visibleAtError = false;
      hosted.onDeltas((deltas) => {
        if (
          deltas.some(
            (delta) => delta.op === "state.updated" && delta.patch.control?.phase === "error",
          )
        ) {
          visibleAtError = hosted.projector
            .getSnapshot()
            .queue.items.some((item) => item.sourceCommandId === "guide");
        }
      });
      await hosted.bridge.admitSend({
        text: "initial",
        commandId: "initial",
        clientId: "desktop",
        delivery: "startNow",
        streaming: false,
      });
      await entered.promise;
      assert.equal(
        (
          await hosted.bridge.admitSend({
            text: "keep my guide",
            commandId: "guide",
            clientId: "desktop",
            delivery: "guide",
            streaming: true,
          })
        ).kind,
        "steer",
      );
      if (outcome === "abort") {
        hosted.queue.autoDrain = false;
        for (const commandId of ["ordinary-first", "ordinary-second"]) {
          assert.equal(
            (
              await hosted.bridge.admitSend({
                text: commandId,
                commandId,
                clientId: "desktop",
                delivery: "queue",
                streaming: true,
              })
            ).kind,
            "queued",
          );
        }
      }
      hosted.projector.replaceQueue(hosted.queue.snapshot());
      const aborted = outcome === "abort" ? hosted.bridge.stop() : undefined;
      release.resolve();
      await aborted;
      await hosted.waitTurn();
      if (outcome === "abort") {
        assert.deepEqual(
          hosted.queue.snapshot().items.map((item) => item.sourceCommandId),
          ["guide", "ordinary-first", "ordinary-second"],
        );
        assert.equal(hosted.projector.getSnapshot().queue.items[0]?.text, "keep my guide");
        assert.equal(await hosted.bridge.drainNext(), false);
        assert.deepEqual(submitted, ["initial", "keep my guide"]);
        hosted.queue.autoDrain = true;
        assert.equal(await hosted.bridge.drainNext(), true);
        await hosted.waitTurn();
        // Registry 在 settled 边界继续消费普通 FIFO，GUIDE 只由 SDK 自己消费。
        await new Promise<void>((resolve) => setImmediate(resolve));
        await hosted.waitTurn();
        assert.deepEqual(submitted, [
          "initial",
          "keep my guide",
          "ordinary-first",
          "ordinary-second",
        ]);
        assert.deepEqual(
          hosted.projector
            .getSnapshot()
            .rows.window.filter(
              (row) => row.kind === "userInput" && row.sourceCommandId?.startsWith("ordinary-"),
            )
            .map((row) => (row.kind === "userInput" ? row.sourceCommandId : undefined)),
          ["ordinary-first", "ordinary-second"],
        );
      } else {
        // SDK 在错误后的 post-run 阶段主动继续消费 steering，Host 不应重发或提前清理。
        assert.equal(visibleAtError, true);
        assert.equal(calls, 2);
      }
      assert.equal(hosted.queue.snapshot().items.length, 0);
      const guideRows = hosted.projector
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "userInput" && row.sourceCommandId === "guide");
      assert.equal(guideRows.length, 1);
    },
  );
}
