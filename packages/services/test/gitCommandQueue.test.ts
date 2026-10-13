import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";

function provider() {
  return createGitCommandProvider({
    environmentProvider: {
      async resolveGitBinary() {
        return process.execPath;
      },
      createCommandEnv() {
        return { ...process.env };
      },
    },
    timeoutKillGraceMs: 50,
    timeoutForceKillGraceMs: 50,
  });
}

test("git commands on the same directory run one at a time", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-queue-"));
  const logPath = join(cwd, "log.txt");
  const git = provider();
  try {
    await Promise.all([
      git.run({
        cwd,
        args: [
          "-e",
          "const fs=require('node:fs'); fs.appendFileSync(process.env.LOG,'A-start\\n'); setTimeout(()=>fs.appendFileSync(process.env.LOG,'A-end\\n'), 400);",
        ],
        env: { LOG: logPath },
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }),
      git.run({
        cwd,
        args: ["-e", "require('node:fs').appendFileSync(process.env.LOG,'B\\n')"],
        env: { LOG: logPath },
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }),
    ]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log, "A-start\nA-end\nB\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("git commands on different directories can overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-queue-"));
  const left = join(root, "left");
  const right = join(root, "right");
  const logPath = join(root, "log.txt");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(left);
  await mkdir(right);
  const git = provider();
  try {
    await Promise.all([
      git.run({
        cwd: left,
        args: [
          "-e",
          "setTimeout(()=>require('node:fs').appendFileSync(process.env.LOG,'A\\n'), 400)",
        ],
        env: { LOG: logPath },
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }),
      git.run({
        cwd: right,
        args: ["-e", "require('node:fs').appendFileSync(process.env.LOG,'B\\n')"],
        env: { LOG: logPath },
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }),
    ]);
    const log = await readFile(logPath, "utf8");
    assert.equal(log, "B\nA\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized git output kills the process instead of leaving it running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "git-queue-"));
  const pidPath = join(cwd, "pid.txt");
  const git = provider();
  try {
    const startedAt = Date.now();
    const result = await git.run({
      cwd,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.env.PID, String(process.pid)); process.stdout.write('x'.repeat(200000)); setTimeout(()=>{}, 30000);",
      ],
      env: { PID: pidPath },
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    assert.equal(result.outputTruncated, true);
    assert.ok(Date.now() - startedAt < 8_000);
    const pid = Number(await readFile(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
