import assert from "node:assert/strict";
import test from "node:test";
import { CommandBridge } from "./command-bridge.js";
import { FakePiSession } from "./fake-session.js";
import { HostQueue } from "./host-queue.js";

const send = (commandId: string) => ({
  text: commandId,
  commandId,
  clientId: "test",
  delivery: "startNow" as const,
  streaming: false,
});

test("an in-flight Registry drain excludes another drain and ordinary input cannot overtake", async () => {
  const session = new FakePiSession("consumer");
  const queue = new HostQueue();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bridge = new CommandBridge(session, queue, async () => {
    entered.resolve();
    await release.promise;
  });
  const original = queue.createItem({
    sourceCommandId: "original",
    clientId: "test",
    text: "original",
    admitted: "queue",
    modelSelection: { providerId: "p", modelId: "m" },
  });
  queue.enqueue(original);
  const draining = bridge.drainNext();
  try {
    await entered.promise;
    assert.equal(await bridge.drainNext(), false);
    const queued = await bridge.admitSend({ ...send("later"), delivery: "guide" });
    assert.equal(queued.kind, "queued");
    assert.deepEqual(session.prompts, []);
    assert.deepEqual(session.steers, []);
    release.resolve();
    assert.equal(await draining, true);
    assert.deepEqual(session.prompts, ["original"]);
    assert.deepEqual(
      queue.snapshot().items.map((item) => item.sourceCommandId),
      ["later"],
    );
    assert.equal(queue.canAutoDrain, true);
  } finally {
    release.resolve();
    await draining;
  }
});

test("idle-only guide rejects busy before enqueue or steer and releases its claim", async () => {
  const session = new FakePiSession("consumer");
  session.isStreaming = true;
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue);
  await assert.rejects(
    bridge.admitSend({ ...send("idle-only"), delivery: "guide", requireIdle: true }),
    { reasonCode: "guard.queuePromotionBusy" },
  );
  assert.deepEqual(queue.snapshot().items, []);
  assert.deepEqual(session.steers, []);
  assert.deepEqual(session.prompts, []);
  assert.equal(queue.canAutoDrain, true);
});

test("idle-only rejects when model loading becomes busy and cannot steer or enqueue", async () => {
  const session = new FakePiSession("consumer");
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue, async () => {
    session.isStreaming = true;
  });
  await assert.rejects(
    bridge.admitSend({
      ...send("idle-only"),
      delivery: "guide",
      requireIdle: true,
      modelSelection: { providerId: "p", modelId: "m" },
    }),
  );
  assert.deepEqual(queue.snapshot().items, []);
  assert.deepEqual(session.steers, []);
  assert.deepEqual(session.prompts, []);
});

test("consumer release is idempotent and cannot override a hold or release a new owner", async () => {
  const queue = new HostQueue();
  const first = queue.tryAcquireConsumer();
  assert.ok(first);
  assert.equal(queue.tryAcquireConsumer(), undefined);
  assert.equal(queue.canAutoDrain, false);
  queue.autoDrain = false;
  first.release();
  await first.released;
  assert.equal(queue.autoDrain, false);
  assert.equal(queue.consumerReleased, undefined);
  const second = queue.tryAcquireConsumer();
  assert.ok(second);
  first.release();
  assert.equal(queue.ownsConsumer(second), true);
  assert.equal(queue.ownsConsumer(first), false);
  second.release();
  assert.equal(queue.autoDrain, false);
});

test("a V4 caller-owned consumer stays held through bridge admission", async () => {
  const queue = new HostQueue();
  const session = new FakePiSession("consumer");
  const bridge = new CommandBridge(session, queue);
  const consumer = queue.tryAcquireConsumer();
  assert.ok(consumer);
  assert.equal(
    (await bridge.admitSend({ ...send("promoted"), requireIdle: true, consumer })).kind,
    "prompt",
  );
  assert.equal(queue.ownsConsumer(consumer), true);
  consumer.release();
  assert.equal(queue.consumerReleased, undefined);
  await assert.rejects(bridge.admitSend({ ...send("stale"), consumer }), {
    reasonCode: "guard.queuePromotionBusy",
  });
  assert.deepEqual(session.prompts, ["promoted"]);
});

test("failed Registry admission restores its original item and releases the consumer", async () => {
  const queue = new HostQueue();
  const session = new FakePiSession("consumer");
  session.acceptPrompt = false;
  const bridge = new CommandBridge(session, queue);
  const original = queue.createItem({
    sourceCommandId: "failed",
    clientId: "test",
    text: "failed",
    admitted: "queue",
  });
  queue.enqueue(original);
  await assert.rejects(bridge.drainNext());
  assert.deepEqual(queue.snapshot().items, [original]);
  assert.equal(queue.canAutoDrain, true);
});

test("idle-only extension propagates attachment failure before acknowledging or releasing caller claim", async () => {
  const queue = new HostQueue();
  const session = new FakePiSession("extension");
  session.slashCommands = [
    { name: "settings", source: "extension", description: "Settings", inputHint: "" },
  ];
  const bridge = new CommandBridge(session, queue);
  const consumer = queue.tryAcquireConsumer();
  assert.ok(consumer);
  await assert.rejects(
    bridge.admitSend({
      ...send("ext"),
      text: "/settings",
      requireIdle: true,
      consumer,
      attachments: [{ type: "image", content: "invalid", fileName: "invalid.png" }],
    }),
    /image unreadable/,
  );
  assert.deepEqual(session.prompts, []);
  assert.equal(queue.ownsConsumer(consumer), true);
  consumer.release();
});

test("idle-only extension holds consumer through preparation and returns after invocation without waiting for answers", async () => {
  const queue = new HostQueue();
  const session = new FakePiSession("extension");
  session.slashCommands = [
    { name: "settings", source: "extension", description: "Settings", inputHint: "" },
  ];
  const ready = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<boolean | "handled">();
  const bridge = new CommandBridge(session, queue, undefined, undefined, {
    uiReady: ready.promise,
    async run(_command, execute) {
      await execute();
    },
  });
  session.prompt = (text) => {
    session.prompts.push(text);
    return answered.promise;
  };
  const consumer = queue.tryAcquireConsumer();
  assert.ok(consumer);
  const admission = bridge.admitSend({
    ...send("ext"),
    text: "/settings",
    requireIdle: true,
    consumer,
  });
  try {
    assert.equal(queue.ownsConsumer(consumer), true);
    assert.deepEqual(session.prompts, []);
    ready.resolve();
    assert.equal((await admission).kind, "handled");
    assert.deepEqual(session.prompts, ["/settings"]);
    assert.equal(queue.ownsConsumer(consumer), true);
  } finally {
    ready.resolve();
    answered.resolve("handled");
    consumer.release();
  }
});
