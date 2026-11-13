import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CommandBridge } from "./command-bridge.js";
import { HostQueue } from "./host-queue.js";
import { createSdkSessionFactory } from "./session-factory.js";
import type { PiHostEvent } from "./types.js";

for (const action of ["race", "transform", "beforeStart", "handled", "failure"] as const) {
  test(`real SDK guide input handler: ${action}`, { timeout: 20_000 }, async (t) => {
    const tempRoot = process.platform === "win32" ? "D:/tmp" : tmpdir();
    await mkdir(tempRoot, { recursive: true });
    const dir = await mkdtemp(join(tempRoot, "picode-guide-handler-"));
    const streamEntered = Promise.withResolvers<void>();
    const streamRelease = Promise.withResolvers<void>();
    const inputEntered = Promise.withResolvers<void>();
    const inputRelease = Promise.withResolvers<void>();
    const key = `picode-guide-${dir}`;
    Reflect.set(globalThis, key, { inputEntered, inputRelease });
    await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "extensions", "guide.js"),
      `
export default function(pi) {
  pi.on("input", async (event) => {
    if (event.source === "extension" || event.text === "initial") return { action: "continue" };
    const state = globalThis[${JSON.stringify(key)}];
    if (event.text === "race" || event.text === "beforeStart") {
      state.inputEntered.resolve();
      await state.inputRelease.promise;
      return { action: "transform", text: "transformed " + event.text };
    }
    if (event.text === "transform") {
      pi.sendUserMessage("same input", { deliverAs: "steer" });
      return { action: "transform", text: "transformed guide" };
    }
    if (event.text === "handled") return { action: "handled" };
    if (event.text === "failure") throw new Error("input fixture failed");
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    if (event.prompt === "transformed beforeStart")
      pi.sendUserMessage("same input", { deliverAs: "steer" });
  });
}
`,
    );
    let calls = 0;
    const factory = createSdkSessionFactory({
      agentDir: join(dir, "agent"),
      stream: async function* () {
        calls += 1;
        if (calls === 1) {
          streamEntered.resolve();
          await streamRelease.promise;
        }
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    });
    const session = await factory({
      sessionId: "input-handler",
      cwd: dir,
      sessionFile: join(dir, "session.jsonl"),
      loadExtensions: true,
    });
    const events: PiHostEvent[] = [];
    session.subscribe((event) => events.push(event));
    t.after(async () => {
      streamRelease.resolve();
      inputRelease.resolve();
      await session.dispose();
      Reflect.deleteProperty(globalThis, key);
      await rm(dir, { recursive: true, force: true });
    });
    const queue = new HostQueue();
    const bridge = new CommandBridge(session, queue);
    bridge.syncFollowupMode("guide");
    await session.prompt("initial");
    await streamEntered.promise;
    const admission = bridge.admitSend({
      text: action,
      commandId: "guide",
      clientId: "desktop",
      delivery: "guide",
      streaming: true,
    });
    if (action === "race" || action === "beforeStart") {
      await inputEntered.promise;
      streamRelease.resolve();
      await session.waitTurn?.();
      assert.equal(session.isIdle, true);
      inputRelease.resolve();
      assert.equal((await admission).kind, "prompt");
    } else {
      const result = await admission;
      // SDK 会把 input handler 抛错报告为 extension_error 并继续处理输入。
      assert.equal(result.kind, action === "handled" ? "handled" : "steer");
      assert.equal(queue.snapshot().items.length, action === "handled" ? 0 : 1);
      streamRelease.resolve();
    }
    await session.waitTurn?.();
    const users = events.filter(
      (event) => event.type === "message_start" && event.message.role === "user",
    );
    const owned = users.filter(
      (event) =>
        event.type === "message_start" && event.message.picodeInput?.sourceCommandId === "guide",
    );
    assert.equal(owned.length, action === "handled" ? 0 : 1);
    if (action === "transform" || action === "beforeStart") {
      assert.equal(users.length, 3);
      assert.equal(
        users.filter((event) => event.type === "message_start" && !event.message.picodeInput)
          .length,
        2,
      );
      assert.match(
        JSON.stringify(owned),
        action === "transform" ? /transformed guide/ : /transformed beforeStart/,
      );
    }
    if (action === "race") {
      assert.equal(calls, 2);
      assert.match(JSON.stringify(owned), /transformed race/);
    }
  });
}
