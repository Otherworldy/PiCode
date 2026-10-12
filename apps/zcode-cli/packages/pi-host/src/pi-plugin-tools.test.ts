import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnOptions } from "node:child_process";
import { commandExitsZero } from "./pi-plugin-tools.js";

function fakeSpawn(result: "ok" | "missing" | "fail" | "hang") {
  return (_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const listeners = new Map<string, (value?: number | null) => void>();
    const child = {
      kill() {
        listeners.get("exit")?.(null);
      },
      once(event: "error" | "exit", listener: (value?: number | null) => void) {
        listeners.set(event, listener);
      },
    };
    queueMicrotask(() => {
      if (result === "hang") return;
      if (result === "missing") listeners.get("error")?.();
      else listeners.get("exit")?.(result === "ok" ? 0 : 1);
    });
    return child;
  };
}

test("a zero exit counts as installed", async () => {
  assert.equal(await commandExitsZero("git", fakeSpawn("ok")), true);
});

test("a missing command or a failed exit counts as not installed", async () => {
  assert.equal(await commandExitsZero("npm", fakeSpawn("missing")), false);
  assert.equal(await commandExitsZero("git", fakeSpawn("fail")), false);
});

test("a command that does not exit in time counts as not installed", async () => {
  assert.equal(await commandExitsZero("npm", fakeSpawn("hang"), 20), false);
});
