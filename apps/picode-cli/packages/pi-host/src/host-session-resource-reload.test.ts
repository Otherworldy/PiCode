import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakePiSession } from "./fake-session.js";
import { HostSessionRegistry } from "./session-registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-host-reload-"));
  const pi = Object.assign(new FakePiSession("reload-test"), {
    isIdle: true,
    reloadCalls: 0,
    async reloadResources() {
      this.reloadCalls++;
    },
  });
  const registry = new HostSessionRegistry({
    storageRoot: join(root, "meta"),
    nativeSessionsRoot: join(root, "sessions"),
    createSession: async () => pi,
  });
  const hosted = await registry.create({ sessionId: pi.sessionId, workspacePath: root });
  return {
    pi,
    hosted,
    registry,
    async close() {
      await hosted.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("idle resource reload retains hosted identity, projection and queue preferences", async () => {
  const f = await fixture();
  try {
    f.hosted.queue.autoDrain = false;
    f.hosted.queue.followupMode = "guide";
    const epoch = f.hosted.projector.getSnapshot().logEpoch;
    await f.hosted.reloadResources();
    assert.equal(f.pi.reloadCalls, 1);
    assert.equal(f.registry.get(f.hosted.sessionId), f.hosted);
    assert.equal(f.hosted.projector.getSnapshot().logEpoch, epoch);
    assert.equal(f.hosted.queue.autoDrain, false);
    assert.equal(f.hosted.queue.followupMode, "guide");
  } finally {
    await f.close();
  }
});

test("busy SDK states and queued input reject reload before any shutdown", async () => {
  const f = await fixture();
  try {
    for (const key of ["isStreaming", "isCompacting"] as const) {
      f.pi[key] = true;
      await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
      f.pi[key] = false;
    }
    f.pi.isIdle = false;
    await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
    f.pi.isIdle = true;
    f.hosted.queue.enqueue(
      f.hosted.queue.createItem({
        sourceCommandId: "q",
        clientId: "test",
        text: "queued",
        admitted: "queue",
      }),
    );
    await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
    assert.equal(f.pi.reloadCalls, 0);
    assert.equal(f.hosted.queue.snapshot().items.length, 1);
  } finally {
    await f.close();
  }
});

test("reload holds the same queue consumer as input admission and releases it on failure", async () => {
  const f = await fixture();
  try {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.pi.reloadResources = async () => {
      entered.resolve();
      await finish.promise;
      throw new Error("reload failed");
    };
    const pending = f.hosted.reloadResources();
    await entered.promise;
    assert.equal(f.hosted.hasResidencyBlockingWork, true);
    assert.equal(f.hosted.queue.tryAcquireConsumer(), undefined);
    await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
    finish.resolve();
    await assert.rejects(pending, { reasonCode: "fault.command.sessionReloadFailed" });
    assert.equal(f.hosted.hasResidencyBlockingWork, false);
    const claim = f.hosted.queue.tryAcquireConsumer();
    assert.ok(claim);
    claim.release();
  } finally {
    await f.close();
  }
});

test("branch summary and pending interaction protect their runtime resources", async () => {
  const f = await fixture();
  try {
    f.hosted.noteBranchSummary(true);
    await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
    f.hosted.noteBranchSummary(false);
    f.hosted.ui.handle({ id: "choose", method: "select", title: "Choose", options: ["one"] });
    const request = f.hosted.ui.wait("choose");
    f.hosted.publishUi();
    await assert.rejects(f.hosted.reloadResources(), { reasonCode: "guard.sessionReloadBusy" });
    f.hosted.ui.respond({ id: "choose", cancelled: true });
    await request;
    assert.equal(f.pi.reloadCalls, 0);
  } finally {
    await f.close();
  }
});
