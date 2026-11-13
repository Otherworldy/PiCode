import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSdkSessionFactory } from "./session-factory.js";
import { HostSessionRegistry } from "./session-registry.js";
import { readPiJsonl } from "./jsonl-history.js";
import type { PiSessionPort } from "./types.js";

for (const profile of ["continuous", "replayable"] as const) {
  for (const mode of ["one-at-a-time", "all"] as const) {
    test(
      `${profile}/${mode}: cancel only one same-text GUIDE without restarting handlers or other inputs`,
      { timeout: 20_000 },
      async (t) => {
        const dir = await mkdtemp(
          join(process.platform === "win32" ? "D:/tmp" : tmpdir(), "picode-guide-cancel-"),
        );
        await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
        const key = `guide-cancel:${dir}`;
        const counts = { inputs: 0 };
        Reflect.set(globalThis, key, counts);
        await writeFile(
          join(dir, ".pi", "extensions", "cancel.js"),
          `export default function(pi) {
        let injected = false;
        pi.on("input", (event) => {
          globalThis[${JSON.stringify(key)}].inputs++;
          if (event.text !== "same input") return { action: "continue" };
          if (!injected) { injected = true; pi.sendUserMessage("plugin same input", { deliverAs: "steer" }); }
          return { action: "transform", text: "transformed same input" };
        });
      }`,
        );
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let calls = 0;
        let pi: PiSessionPort;
        const factory = createSdkSessionFactory({
          agentDir: join(dir, "agent"),
          stream: async function* () {
            if (++calls === 1) {
              entered.resolve();
              await release.promise;
            }
            yield { type: "text", text: "done" };
            yield { type: "done" };
          },
        });
        const registry = new HostSessionRegistry({
          storageRoot: dir,
          nativeSessionsRoot: join(dir, "sessions"),
          loadExtensions: true,
          profile,
          createSession: async (input) => (pi = await factory(input)),
          readTitleSummarySettings: async () => ({ enabled: false }),
          completeMemoryPrompt: async () => {
            throw new Error("unexpected memory extraction");
          },
        });
        const hosted = await registry.create({ workspacePath: dir });
        t.after(async () => {
          release.resolve();
          await hosted.dispose();
          Reflect.deleteProperty(globalThis, key);
          await rm(dir, { recursive: true, force: true });
        });
        pi!.setSteeringMode?.(mode);
        await hosted.bridge.admitSend({
          text: "initial",
          commandId: "initial",
          clientId: "desktop",
          delivery: "startNow",
          streaming: false,
        });
        await entered.promise;
        for (const commandId of ["keep", "cancel"]) {
          assert.equal(
            (
              await hosted.bridge.admitSend({
                text: "same input",
                commandId,
                clientId: "desktop",
                delivery: "guide",
                streaming: true,
                attachments: [
                  {
                    type: "image",
                    fileName: "guide.png",
                    ref: "guide-image",
                    mime: "image/png",
                    bytes: 68,
                    content:
                      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=",
                  },
                ],
              })
            ).kind,
            "steer",
          );
        }
        await pi!.followUp("unowned follow-up");
        let observerFailures = 0;
        const stopThrowing = pi!.subscribe((event) => {
          if (event.type === "queue_update") {
            observerFailures++;
            throw new Error("queue observer failure");
          }
        });
        assert.equal(
          pi!.cancelSteering?.({ sourceCommandId: "keep", clientId: "other-client" }),
          false,
        );
        const inputCalls = counts.inputs;
        assert.equal(hosted.bridge.cancelGuide("cancel"), true);
        stopThrowing();
        assert.equal(observerFailures, 1, "the actual SDK queue observer threw after withdrawal");
        assert.equal(
          hosted.queue.snapshot().items.find((item) => item.sourceCommandId === "cancel")
            ?.cancelSettlementPending,
          true,
        );
        hosted.queue.consume("cancel");
        assert.equal(counts.inputs, inputCalls, "cancellation must not rerun input handlers");
        assert.equal(pi!.isStreaming, true, "cancellation must not stop the active model");
        hosted.projector.replaceQueue(hosted.queue.snapshot());
        assert.deepEqual(
          hosted.projector.getSnapshot().queue.items.map((item) => item.sourceCommandId),
          ["keep"],
        );
        release.resolve();
        await hosted.waitTurn();
        const users = readPiJsonl(await readFile(hosted.sessionFile, "utf8")).events.filter(
          (event) => event.type === "message_start" && event.message.role === "user",
        );
        assert.equal(
          users.filter(
            (event) =>
              event.type === "message_start" &&
              event.message.picodeInput?.sourceCommandId === "cancel",
          ).length,
          0,
        );
        assert.equal(
          users.filter(
            (event) =>
              event.type === "message_start" &&
              event.message.picodeInput?.sourceCommandId === "keep",
          ).length,
          1,
        );
        const kept = users.find(
          (event) =>
            event.type === "message_start" && event.message.picodeInput?.sourceCommandId === "keep",
        );
        assert.ok(kept?.type === "message_start");
        assert.equal(kept.message.picodeInput?.attachments?.[0]?.ref, "guide-image");
        const rawKept = (await readFile(hosted.sessionFile, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find(
            (entry) =>
              entry.type === "message" && entry.message.picodeInput?.sourceCommandId === "keep",
          );
        assert.ok(rawKept.message.content.some((part: { type: string }) => part.type === "image"));
        assert.match(JSON.stringify(users), /plugin same input/);
        assert.match(JSON.stringify(users), /unowned follow-up/);
        assert.match(JSON.stringify(users), /transformed same input/);
        assert.equal(hosted.queue.snapshot().items.length, 0);
        assert.equal(
          hosted.bridge.cancelGuide("keep"),
          false,
          "already consumed inputs cannot be cancelled",
        );
      },
    );
  }
}

test(
  "SDK drain wins cancellation while extension delays user message_start",
  { timeout: 20_000 },
  async (t) => {
    const dir = await mkdtemp(
      join(process.platform === "win32" ? "D:/tmp" : tmpdir(), "picode-guide-claimed-"),
    );
    await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
    const key = `guide-claimed:${dir}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    Reflect.set(globalThis, key, { claimed, publish });
    await writeFile(
      join(dir, ".pi", "extensions", "claimed.js"),
      `export default function(pi) {
    pi.on("message_start", async (event) => {
      if (event.message.role !== "user" || !event.message.content.some((part) => part.type === "text" && part.text === "race")) return;
      const state = globalThis[${JSON.stringify(key)}]; state.claimed.resolve(); await state.publish.promise;
    });
  }`,
    );
    let calls = 0;
    const factory = createSdkSessionFactory({
      agentDir: join(dir, "agent"),
      stream: async function* () {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    });
    const registry = new HostSessionRegistry({
      storageRoot: dir,
      nativeSessionsRoot: join(dir, "sessions"),
      loadExtensions: true,
      createSession: factory,
      readTitleSummarySettings: async () => ({ enabled: false }),
      completeMemoryPrompt: async () => {
        throw new Error("unexpected memory extraction");
      },
    });
    const hosted = await registry.create({ workspacePath: dir });
    t.after(async () => {
      release.resolve();
      publish.resolve();
      await hosted.dispose();
      Reflect.deleteProperty(globalThis, key);
      await rm(dir, { recursive: true, force: true });
    });
    await hosted.bridge.admitSend({
      text: "initial",
      commandId: "initial",
      clientId: "desktop",
      delivery: "startNow",
      streaming: false,
    });
    await entered.promise;
    await hosted.bridge.admitSend({
      text: "race",
      commandId: "race",
      clientId: "desktop",
      delivery: "guide",
      streaming: true,
    });
    release.resolve();
    await claimed.promise;
    assert.equal(hosted.queue.snapshot().items.length, 1, "Host event is still pending");
    assert.equal(hosted.bridge.cancelGuide("race"), false, "raw queue is already drained");
    assert.equal(
      hosted.queue.snapshot().items.length,
      1,
      "failed cancellation must preserve handoff",
    );
    publish.resolve();
    await hosted.waitTurn();
    assert.equal(hosted.queue.snapshot().items.length, 0);
    const users = readPiJsonl(await readFile(hosted.sessionFile, "utf8")).events.filter(
      (event) =>
        event.type === "message_start" && event.message.picodeInput?.sourceCommandId === "race",
    );
    assert.equal(users.length, 1);
  },
);

test(
  "cancelling the last GUIDE during turn_end avoids an empty continuation turn",
  { timeout: 20_000 },
  async (t) => {
    const dir = await mkdtemp(
      join(process.platform === "win32" ? "D:/tmp" : tmpdir(), "picode-guide-turn-end-cancel-"),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let pi: PiSessionPort;
    const factory = createSdkSessionFactory({
      agentDir: join(dir, "agent"),
      stream: async function* () {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    });
    const registry = new HostSessionRegistry({
      storageRoot: dir,
      nativeSessionsRoot: join(dir, "sessions"),
      loadExtensions: false,
      createSession: async (input) => (pi = await factory(input)),
      readTitleSummarySettings: async () => ({ enabled: false }),
      completeMemoryPrompt: async () => {
        throw new Error("unexpected memory extraction");
      },
    });
    const hosted = await registry.create({ workspacePath: dir });
    t.after(async () => {
      release.resolve();
      await hosted.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    await hosted.bridge.admitSend({
      text: "initial",
      commandId: "initial",
      clientId: "desktop",
      delivery: "startNow",
      streaming: false,
    });
    await entered.promise;
    await hosted.bridge.admitSend({
      text: "cancel at turn end",
      commandId: "turn-end-cancel",
      clientId: "desktop",
      delivery: "guide",
      streaming: true,
    });
    let cancelled: boolean | undefined;
    const unsubscribe = pi!.subscribe((event) => {
      if (event.type !== "turn_end" || cancelled !== undefined) return;
      cancelled = hosted.bridge.cancelGuide("turn-end-cancel");
      if (cancelled) {
        hosted.queue.consume("turn-end-cancel");
        hosted.projector.replaceQueue(hosted.queue.snapshot());
      }
    });
    t.after(unsubscribe);
    release.resolve();
    await hosted.waitTurn();
    assert.equal(cancelled, true, "SDK has not drained the raw GUIDE before the post-turn poll");
    assert.equal(calls, 1, "cancellation must not trigger an assistant-only continuation");
    const users = readPiJsonl(await readFile(hosted.sessionFile, "utf8")).events.filter(
      (event) => event.type === "message_start" && event.message.role === "user",
    );
    assert.deepEqual(
      users.map((event) =>
        event.type === "message_start" ? event.message.picodeInput?.sourceCommandId : undefined,
      ),
      ["initial"],
    );
  },
);

test(
  "a GUIDE retained after Stop can be cancelled before ordinary FIFO resumes",
  { timeout: 20_000 },
  async (t) => {
    const dir = await mkdtemp(
      join(process.platform === "win32" ? "D:/tmp" : tmpdir(), "picode-guide-stop-cancel-"),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const registry = new HostSessionRegistry({
      storageRoot: dir,
      nativeSessionsRoot: join(dir, "sessions"),
      loadExtensions: false,
      createSession: createSdkSessionFactory({
        agentDir: join(dir, "agent"),
        stream: async function* () {
          if (++calls === 1) {
            entered.resolve();
            await release.promise;
          }
          yield { type: "text", text: "done" };
          yield { type: "done" };
        },
      }),
      readTitleSummarySettings: async () => ({ enabled: false }),
      completeMemoryPrompt: async () => {
        throw new Error("unexpected memory extraction");
      },
    });
    const hosted = await registry.create({ workspacePath: dir });
    t.after(async () => {
      release.resolve();
      await hosted.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    await hosted.bridge.admitSend({
      text: "initial",
      commandId: "initial",
      clientId: "desktop",
      delivery: "startNow",
      streaming: false,
    });
    await entered.promise;
    await hosted.bridge.admitSend({
      text: "cancel after stop",
      commandId: "cancel",
      clientId: "desktop",
      delivery: "guide",
      streaming: true,
    });
    hosted.queue.autoDrain = false;
    await hosted.bridge.admitSend({
      text: "ordinary",
      commandId: "ordinary",
      clientId: "desktop",
      delivery: "queue",
      streaming: true,
    });
    const stopped = hosted.bridge.stop();
    release.resolve();
    await stopped;
    await hosted.waitTurn();
    assert.deepEqual(
      hosted.queue.snapshot().items.map((item) => item.sourceCommandId),
      ["cancel", "ordinary"],
    );
    assert.equal(hosted.bridge.cancelGuide("cancel"), true);
    hosted.queue.consume("cancel");
    hosted.projector.replaceQueue(hosted.queue.snapshot());
    assert.equal(hosted.queue.autoDrain, false);
    hosted.queue.autoDrain = true;
    assert.equal(await hosted.bridge.drainNext(), true);
    await hosted.waitTurn();
    const users = readPiJsonl(await readFile(hosted.sessionFile, "utf8")).events.filter(
      (event) => event.type === "message_start" && event.message.role === "user",
    );
    assert.deepEqual(
      users.map((event) =>
        event.type === "message_start" ? event.message.picodeInput?.sourceCommandId : undefined,
      ),
      ["initial", "ordinary"],
    );
  },
);
