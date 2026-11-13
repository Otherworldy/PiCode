import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPiJsonl } from "./jsonl-history.js";
import { createSdkSessionFactory } from "./session-factory.js";
import type { PiHostEvent, PiPersistedMessage } from "./types.js";

async function extensionFixture(source: (key: string) => string) {
  const root = process.platform === "win32" ? "D:/tmp" : tmpdir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "picode-guide-lifecycle-"));
  const key = `guide-lifecycle:${dir}`;
  await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
  await writeFile(join(dir, ".pi", "extensions", "lifecycle.js"), source(key));
  return { dir, key, sessionFile: join(dir, "session.jsonl") };
}

test(
  "real SDK settled deferral preserves the explicit submission and waits for actual preflight and completion",
  { timeout: 20_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const modelEntered = Promise.withResolvers<void>();
    const modelRelease = Promise.withResolvers<void>();
    const f = await extensionFixture(
      (key) => `export default function(pi) {
    let first = true;
    pi.on("agent_settled", async () => {
      if (!first) return;
      first = false;
      const state = globalThis[${JSON.stringify(key)}];
      state.submit();
      state.entered.resolve();
      await state.release.promise;
    });
  }`,
    );
    let calls = 0;
    const session = await createSdkSessionFactory({
      agentDir: join(f.dir, "agent"),
      stream: async function* () {
        if (++calls === 2) {
          modelEntered.resolve();
          await modelRelease.promise;
        }
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    })({
      sessionId: "settled-deferral",
      cwd: f.dir,
      sessionFile: f.sessionFile,
      loadExtensions: true,
    });
    const events: PiHostEvent[] = [];
    session.subscribe((event) => events.push(event));
    let admission: Promise<unknown> | undefined;
    let acknowledged = false;
    Reflect.set(globalThis, f.key, {
      entered,
      release,
      submit() {
        admission = session
          .prompt("deferred guide", {
            streamingBehavior: "steer",
            picodeInput: { sourceCommandId: "deferred", clientId: "desktop" },
          })
          .then((result) => {
            acknowledged = true;
            return result;
          });
      },
    });
    let firstTurn: Promise<void> | undefined;
    t.after(async () => {
      release.resolve();
      modelRelease.resolve();
      await firstTurn;
      await session.dispose();
      Reflect.deleteProperty(globalThis, f.key);
      await rm(f.dir, { recursive: true, force: true });
    });
    await session.prompt("initial");
    firstTurn = session.waitTurn?.();
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acknowledged, false, "a deferred raw prompt return is not started preflight");
    release.resolve();
    await modelEntered.promise;
    assert.equal(await admission, true);
    let finished = false;
    const completion = session.waitTurn?.().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "completion must wait for the deferred model run");
    modelRelease.resolve();
    await completion;
    const users = events.filter(
      (event) =>
        event.type === "message_start" &&
        event.message.role === "user" &&
        event.message.picodeInput?.sourceCommandId === "deferred",
    );
    assert.equal(users.length, 1);
    const replay = readPiJsonl(await readFile(session.sessionFile!, "utf8"));
    assert.equal(
      replay.events.filter(
        (event) =>
          event.type === "message_start" &&
          event.message.picodeInput?.sourceCommandId === "deferred",
      ).length,
      1,
    );
  },
);

test(
  "real SDK message_end replacement retains input provenance at the final append boundary",
  { timeout: 20_000 },
  async (t) => {
    const f = await extensionFixture(
      () => `export default function(pi) {
    pi.on("message_end", (event) => {
      if (event.message.role !== "user") return;
      return { message: { role: "user", content: [{ type: "text", text: "extension replacement" }], timestamp: event.message.timestamp } };
    });
  }`,
    );
    const session = await createSdkSessionFactory({
      agentDir: join(f.dir, "agent"),
      stream: async function* () {
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    })({
      sessionId: "message-replacement",
      cwd: f.dir,
      sessionFile: f.sessionFile,
      loadExtensions: true,
    });
    t.after(async () => {
      await session.dispose();
      await rm(f.dir, { recursive: true, force: true });
    });
    const notices: PiPersistedMessage[] = [];
    session.notePersistedMessage?.((notice) => notices.push(notice));
    await session.prompt("original guide", {
      streamingBehavior: "steer",
      picodeInput: {
        sourceCommandId: "guide",
        clientId: "desktop",
        attachments: [{ ref: "image-ref", fileName: "guide.png", mime: "image/png", bytes: 1 }],
      },
    });
    await session.waitTurn?.();
    const user = notices.find((notice) => notice.role === "user");
    assert.equal(user?.picodeInput?.sourceCommandId, "guide");
    const entries = (await readFile(session.sessionFile!, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const stored = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    assert.equal(stored?.id, user?.entryId);
    assert.equal(stored?.message.picodeInput?.sourceCommandId, "guide");
    assert.equal(stored?.message.picodeInput?.attachments[0]?.ref, "image-ref");
    assert.equal(stored?.message.content[0]?.text, "extension replacement");
  },
);

test(
  "real SDK write failure emits no persisted user confirmation",
  { timeout: 20_000 },
  async (t) => {
    const f = await extensionFixture(() => "export default function() {}");
    const session = await createSdkSessionFactory({
      agentDir: join(f.dir, "agent"),
      stream: async function* () {
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    })({
      sessionId: "write-failure",
      cwd: f.dir,
      sessionFile: f.sessionFile,
      loadExtensions: false,
    });
    t.after(async () => {
      await session.dispose();
      await rm(f.dir, { recursive: true, force: true });
    });
    await session.prompt("initial");
    await session.waitTurn?.();
    const notices: PiPersistedMessage[] = [];
    const events: PiHostEvent[] = [];
    session.subscribe((event) => events.push(event));
    session.notePersistedMessage?.((notice) => notices.push(notice));
    await rm(session.sessionFile!);
    await mkdir(session.sessionFile!);
    await session.prompt("cannot persist", {
      picodeInput: { sourceCommandId: "failed", clientId: "desktop" },
    });
    await session.waitTurn?.();
    assert.equal(
      events.filter(
        (event) =>
          event.type === "message_start" && event.message.picodeInput?.sourceCommandId === "failed",
      ).length,
      1,
      "consumption must not be mistaken for a durable append",
    );
    assert.equal(
      notices.filter((notice) => notice.picodeInput?.sourceCommandId === "failed").length,
      0,
    );
  },
);
