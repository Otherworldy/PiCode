import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { commandExitsZero, commandFailureText, retainCommandFailure } from "./pi-plugin-tools.js";

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

test("install failure keeps the command error text instead of only the exit code", () => {
  assert.equal(
    commandFailureText("npm", 1, "npm ERR! code E404\nnpm ERR! 404 Not Found - no such package\n"),
    "code E404\n404 Not Found - no such package",
  );
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout, stderr });
  const exits: number[] = [];
  const errors: Error[] = [];
  child.on("exit", (code) => exits.push(code ?? -1));
  child.on("error", (error) => errors.push(error));
  retainCommandFailure(child, "npm");
  stderr.emit("data", "npm ERR! 404 Not Found - missing-package\n");
  child.emit("exit", 1);
  assert.deepEqual(exits, []);
  child.emit("close", 1);
  assert.match(errors[0]?.message ?? "", /404 Not Found - missing-package/);
});
