import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FakePiSession } from "./fake-session.js";
import { HostSessionRegistry, type ConversationOpenTiming } from "./session-registry.js";

test("cold open reports jsonl, pi session, and replay timings once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-open-timing-"));
  const timings: ConversationOpenTiming[] = [];
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    onConversationOpenTiming: (timing) => {
      timings.push(timing);
    },
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const dir = join(root, "pi-host-sessions", Buffer.from(root).toString("base64url"));
  await mkdir(dir, { recursive: true });
  const jsonl = [
    '{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hello pi"}]}}',
    '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join("\n");
  await writeFile(join(dir, "sess_chat.jsonl"), jsonl);
  const opened = await registry.create({
    workspacePath: root,
    sessionId: "sess_chat",
    openReadMs: 7,
  });
  assert.equal(timings.length, 1);
  const timing = timings[0]!;
  assert.equal(timing.sessionId, opened.sessionId);
  assert.equal(timing.bytes, Buffer.byteLength(jsonl));
  assert.ok(timing.eventCount >= 2);
  assert.ok(timing.readJsonlMs >= 7);
  assert.ok(timing.createPiSessionMs >= 0);
  assert.ok(timing.replayMs >= 0);
  assert.ok(opened.projector.getSnapshot().rows.window.some((row) => row.kind === "userInput"));
  await registry.create({ workspacePath: root, sessionId: "sess_chat" });
  assert.equal(timings.length, 1);
  await rm(root, { recursive: true, force: true });
});

test("find matches a header-only file without confusing it with another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-find-"));
  const nativeRoot = join(root, "pi-sessions");
  const cwd = join(root, "proj");
  await mkdir(cwd, { recursive: true });
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: nativeRoot,
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const resolved = resolve(cwd);
  const safePath = `--${resolved.replace(/^[\\/]/u, "").replace(/[\\/:]/gu, "-")}--`;
  const dir = join(nativeRoot, safePath);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "2026-01-02T03-04-05_sess_named.jsonl"),
    [
      '{"type":"session","id":"sess_named","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
      `{"type":"message","id":"pad","message":{"role":"user","content":[{"type":"text","text":"${"y".repeat(200_000)}"}]}}`,
    ].join("\n"),
  );
  const legacyFile = join(dir, "notes.jsonl");
  await writeFile(
    legacyFile,
    [
      `{"type":"session","id":"sess_legacy","timestamp":"2026-01-02T03:04:05.000Z","cwd":${JSON.stringify(cwd)}}`,
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"legacy"}]}}',
    ].join("\n"),
  );
  const found = await registry.find("sess_legacy");
  assert.equal(found?.sessionFile, legacyFile);
  const named = await registry.find("sess_named");
  assert.equal(named?.sessionId, "sess_named");
  await rm(root, { recursive: true, force: true });
});

test("create uses the session file already found and does not open a new file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-stored-"));
  const timings: ConversationOpenTiming[] = [];
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    onConversationOpenTiming: (timing) => {
      timings.push(timing);
    },
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const sessionFile = join(root, "outside.jsonl");
  const jsonl = [
    '{"type":"session","id":"sess_outside","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"outside"}]}}',
  ].join("\n");
  await writeFile(sessionFile, jsonl);
  const opened = await registry.create({
    workspacePath: root,
    sessionId: "sess_outside",
    openReadMs: 4,
    storedSession: {
      sessionId: "sess_outside",
      sessionFile,
      identity: root,
      workspacePath: root,
    },
  });
  assert.equal(opened.sessionFile, sessionFile);
  assert.equal(timings.length, 1);
  assert.equal(timings[0]?.bytes, Buffer.byteLength(jsonl));
  assert.ok((timings[0]?.readJsonlMs ?? 0) >= 4);
  assert.ok(opened.projector.getSnapshot().rows.window.some((row) => row.kind === "userInput"));
  await rm(root, { recursive: true, force: true });
});
