import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  commandExitsZero,
  commandFailureText,
  removeIncompleteGitCheckout,
  retainCommandFailure,
  withFreshGitCheckout,
} from "./pi-plugin-tools.js";

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

test("incomplete git checkout is removed only inside the managed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-checkout-"));
  const managed = join(root, "git");
  const broken = join(managed, "github.com", "Otherworldy", "pi-processes-bash");
  const kept = join(managed, "github.com", "Otherworldy", "pi-ask-me");
  const outside = join(root, "elsewhere");
  await mkdir(broken, { recursive: true });
  await mkdir(join(kept, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(broken, "package.json"), "{}");

  await removeIncompleteGitCheckout(broken, managed);
  await removeIncompleteGitCheckout(kept, managed);
  await removeIncompleteGitCheckout(outside, managed);
  await removeIncompleteGitCheckout(managed, managed);

  assert.equal(existsSync(broken), false);
  assert.equal(existsSync(kept), true);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(managed), true);
});

test("Pi's git install path is cleared when the checkout has no .git", async () => {
  const { DefaultPackageManager, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent",
  );
  const root = await mkdtemp(join(tmpdir(), "pi-git-real-"));
  const agent = join(root, "agent");
  const cwd = join(root, "proj");
  await mkdir(agent, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const settings = SettingsManager.create(cwd, agent);
  const packages = new DefaultPackageManager({ cwd, agentDir: agent, settingsManager: settings });
  const source = "https://github.com/Otherworldy/pi-processes-bash";
  const manager = packages as unknown as {
    parseSource(source: string): { type: string };
    getGitInstallRoot(scope: "user"): string;
    getGitInstallPath(source: { type: string }, scope: "user"): string;
  };
  const target = manager.getGitInstallPath(manager.parseSource(source), "user");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "README.md"), "partial");
  let runs = 0;
  await withFreshGitCheckout(packages, source, "user", async () => {
    runs += 1;
    if (runs === 1) {
      assert.equal(existsSync(target), false);
      await mkdir(target, { recursive: true });
      throw new Error(
        "git rev-parse origin/HEAD failed with code 128: fatal: not a git repository (or any of the parent directories): .git",
      );
    }
    assert.equal(existsSync(target), false);
  });
  assert.equal(runs, 2);
});

test("an existing git checkout is kept and only recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-keep-"));
  const managed = join(root, "git");
  const target = join(managed, "github.com", "Otherworldy", "pi-processes-bash");
  await mkdir(target, { recursive: true });
  const init = spawnSync("git", ["init"], { cwd: target });
  assert.equal(init.status, 0);
  const source = "https://github.com/Otherworldy/pi-processes-bash";
  let runs = 0;
  let saved = "";
  await withFreshGitCheckout(
    {
      parseSource() {
        return { type: "git" };
      },
      getGitInstallRoot() {
        return managed;
      },
      getGitInstallPath() {
        return target;
      },
      addSourceToSettings(value: string) {
        saved = value;
        return true;
      },
    },
    source,
    "user",
    async () => {
      runs += 1;
    },
    { acceptExisting: true },
  );
  assert.equal(runs, 0);
  assert.equal(saved, source);
  assert.equal(existsSync(join(target, ".git")), true);
});

test("EPERM while deleting an existing git checkout still counts as installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-eperm-"));
  const managed = join(root, "git");
  const target = join(managed, "github.com", "Otherworldy", "pi-processes-bash");
  await mkdir(join(target, ".git"), { recursive: true });
  const source = "https://github.com/Otherworldy/pi-processes-bash";
  let saved = "";
  await withFreshGitCheckout(
    {
      parseSource() {
        return { type: "git" };
      },
      getGitInstallRoot() {
        return managed;
      },
      getGitInstallPath() {
        return target;
      },
      addSourceToSettings(value: string) {
        saved = value;
        return true;
      },
    },
    source,
    "user",
    async () => {
      const init = spawnSync("git", ["init"], { cwd: target });
      assert.equal(init.status, 0);
      throw new Error(`EPERM, Permission denied: \\?\\${target} '${target}'`);
    },
    { acceptExisting: true },
  );
  assert.equal(saved, source);
  assert.equal(existsSync(join(target, ".git")), true);
});

test("a poisoned git checkout is removed once and the install runs again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-poison-"));
  const managed = join(root, "git");
  const target = join(managed, "github.com", "Otherworldy", "pi-processes-bash");
  await mkdir(target, { recursive: true });
  const source = "https://github.com/Otherworldy/pi-processes-bash";
  let runs = 0;
  const packages = {
    parseSource(value: string) {
      assert.equal(value, source);
      return { type: "git" as const };
    },
    getGitInstallRoot() {
      return managed;
    },
    getGitInstallPath() {
      return target;
    },
  };
  await withFreshGitCheckout(packages, source, "user", async () => {
    runs += 1;
    if (runs === 1) {
      await mkdir(target, { recursive: true });
      throw new Error(
        "git rev-parse origin/HEAD failed with code 128: fatal: not a git repository (or any of the parent directories): .git",
      );
    }
  });
  assert.equal(runs, 2);
  assert.equal(existsSync(target), false);
});

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
