import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { branchPiSessionFile } from "./session-factory.js";

test("branch keeps the path to the chosen reply and drops the later one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-branch-"));
  const source = join(root, "parent.jsonl");
  const stamp = "2026-01-02T03:04:05.000Z";
  await writeFile(
    source,
    [
      JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: stamp, cwd: root }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.parse(stamp) },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: stamp,
        message: { role: "assistant", content: [{ type: "text", text: "pong" }], timestamp: Date.parse(stamp) },
      }),
      JSON.stringify({
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: "later" }], timestamp: Date.parse(stamp) },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "u2",
        timestamp: stamp,
        message: { role: "assistant", content: [{ type: "text", text: "after" }], timestamp: Date.parse(stamp) },
      }),
    ].join("\n"),
  );
  const branched = branchPiSessionFile(source, "a1");
  const text = await readFile(branched.sessionFile, "utf8");
  assert.equal(text.includes("pong"), true);
  assert.equal(text.includes("later"), false);
  assert.notEqual(branched.sessionId, "parent");
  await rm(root, { recursive: true, force: true });
});

test("branch accepts the assistant message id when it is not the tree entry id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-branch-msg-"));
  const source = join(root, "parent.jsonl");
  const stamp = "2026-01-02T03:04:05.000Z";
  await writeFile(
    source,
    [
      JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: stamp, cwd: root }),
      JSON.stringify({
        type: "message",
        id: "entry-a",
        parentId: null,
        timestamp: stamp,
        message: {
          role: "assistant",
          id: "msg-a",
          content: [{ type: "text", text: "pong" }],
          timestamp: Date.parse(stamp),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "entry-b",
        parentId: "entry-a",
        timestamp: stamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "later" }],
          timestamp: Date.parse(stamp),
        },
      }),
    ].join("\n"),
  );
  const branched = branchPiSessionFile(source, "msg-a");
  const text = await readFile(branched.sessionFile, "utf8");
  assert.equal(text.includes("pong"), true);
  assert.equal(text.includes("later"), false);
  await rm(root, { recursive: true, force: true });
});
