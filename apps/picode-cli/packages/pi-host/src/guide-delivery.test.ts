import assert from "node:assert/strict";
import test from "node:test";
import { CommandBridge } from "./command-bridge.js";
import { FakePiSession } from "./fake-session.js";
import { HostQueue } from "./host-queue.js";
import { PiToV4Projector } from "./projector.js";

const guide = (commandId: string) => ({
  text: "same input",
  commandId,
  clientId: "desktop",
  delivery: "guide" as const,
  streaming: true,
});

test("accepted steering stays visible and cannot be delivered again by an idle Host drain", async () => {
  const session = new FakePiSession("guide");
  session.isStreaming = true;
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue);
  assert.equal((await bridge.admitSend(guide("g1"))).kind, "steer");
  const [item] = queue.snapshot().items;
  assert.equal(item?.sourceCommandId, "g1");
  assert.equal(item?.text, "same input");
  assert.equal(item?.delivery.admitted, "guide");
  assert.equal(item?.dispatch.state, "reserved");
  assert.equal(queue.edit("g1", "changed"), null);
  assert.equal(queue.remove("g1"), null);
  assert.equal(queue.reorder("g1", null), null);
  assert.equal(queue.clear().items.length, 1);
  session.isStreaming = false;
  assert.equal(await bridge.drainNext(), false);
  assert.deepEqual(session.steers, ["same input"]);
  assert.deepEqual(session.prompts, []);
  assert.equal(queue.snapshot().items.length, 1);
});

test("guide preparation crossing busy to idle starts a turn instead of stranding a steer", async () => {
  const session = new FakePiSession("guide");
  session.isStreaming = true;
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue, async () => {
    session.isStreaming = false;
  });
  const result = await bridge.admitSend({
    ...guide("g2"),
    modelSelection: { providerId: "p", modelId: "m" },
  });
  assert.equal(result.kind, "prompt");
  assert.deepEqual(session.steers, []);
  assert.deepEqual(session.prompts, ["same input"]);
});

for (const outcome of [false, "handled"] as const) {
  test(`guide ${outcome === false ? "rejection" : "handled"} removes provisional pending state`, async () => {
    const session = new FakePiSession("guide");
    session.isStreaming = true;
    session.acceptPrompt = outcome;
    const queue = new HostQueue();
    const bridge = new CommandBridge(session, queue);
    if (outcome === false) await assert.rejects(bridge.admitSend(guide("g")), /prompt rejected/);
    else assert.equal((await bridge.admitSend(guide("g"))).kind, "handled");
    assert.deepEqual(queue.snapshot().items, []);
    assert.equal(queue.canAutoDrain, true);
  });
}

for (const profile of ["continuous", "replayable"] as const) {
  test(`${profile}: consumption atomically hands a guide to its own user row by command identity`, () => {
    const projector = new PiToV4Projector("s", "e", { profile });
    const queue = new HostQueue();
    const items = ["g1", "g2"].map((sourceCommandId) => {
      const item = queue.createItem({
        sourceCommandId,
        clientId: "desktop",
        text: "same input",
        admitted: "guide",
      });
      item.dispatch.state = "reserved";
      item.steer.state = "steering";
      queue.enqueue(item);
      return item;
    });
    projector.replaceQueue(queue.snapshot());
    projector.apply({ type: "agent_start" });
    // 插件自产的同文消息没有命令身份，不能消耗用户的 GUIDE。
    projector.apply({ type: "message_start", message: { role: "user", content: "same input" } });
    assert.equal(projector.getSnapshot().queue.items.length, 2);
    const message = {
      role: "user",
      content: "transformed by an extension",
      id: "sdk-message",
      picodeInput: { sourceCommandId: "g2", clientId: "desktop" },
    };
    const deltas = projector.apply({ type: "message_start", message });
    const append = deltas.find(
      (delta) => delta.op === "row.appended" && delta.row.kind === "userInput",
    );
    assert.ok(append?.op === "row.appended" && append.row.kind === "userInput");
    assert.equal(append.row.sourceCommandId, "g2");
    assert.equal(append.row.clientId, "desktop");
    assert.ok(
      deltas.some((delta) => delta.op === "state.updated" && delta.patch.queue?.items.length === 1),
    );
    assert.deepEqual(projector.getSnapshot().queue.items, [items[0]]);
    const persisted = projector.bindPersistedUserEntry(
      { sourceCommandId: "g2", clientId: "desktop" },
      "disk-entry",
    );
    assert.ok(
      persisted.some((delta) => delta.op === "row.upserted" && delta.row.entityId === "disk-entry"),
    );
    assert.deepEqual(
      projector.bindPersistedUserEntry({ sourceCommandId: "g2", clientId: "other" }, "wrong-entry"),
      [],
    );
    assert.equal(
      projector
        .getSnapshot()
        .rows.window.find((row) => row.kind === "userInput" && row.sourceCommandId === "g2")
        ?.entityId,
      "disk-entry",
    );
  });
}
