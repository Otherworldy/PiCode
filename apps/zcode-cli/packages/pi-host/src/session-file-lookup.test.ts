import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  probeSessionHeaderPrefix,
  readSessionHeaderId,
  sessionFileNameMatches,
} from "./session-file-lookup.js";

test("session file name matches the id or the Pi timestamp prefix", () => {
  assert.equal(sessionFileNameMatches("sess_chat.jsonl", "sess_chat"), true);
  assert.equal(sessionFileNameMatches("2026-01-02T03-04-05_01native.jsonl", "01native"), true);
  assert.equal(sessionFileNameMatches("2026-01-02T03-04-05_01native.jsonl", "01nat"), false);
  assert.equal(sessionFileNameMatches("notes.jsonl", "sess_legacy"), false);
});

test("header probe reads the session id and ignores a different file", () => {
  assert.deepEqual(
    probeSessionHeaderPrefix('{"type":"session","id":"sess_legacy","cwd":"/work"}\n{"type":"message"}', false),
    { status: "id", id: "sess_legacy" },
  );
  assert.deepEqual(
    probeSessionHeaderPrefix('{"type":"session","id":"other"}\n', false),
    { status: "id", id: "other" },
  );
  assert.deepEqual(probeSessionHeaderPrefix('{"type":"message","id":"u1"}', false), { status: "miss" });
  assert.deepEqual(probeSessionHeaderPrefix('{"type":"session","id":"cut"', true), { status: "unknown" });
});

test("header reader does not need the rest of a large jsonl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-host-header-"));
  const file = join(dir, "notes.jsonl");
  await writeFile(file, `{"type":"session","id":"sess_legacy"}\n${"x".repeat(2_000_000)}`);
  assert.deepEqual(await readSessionHeaderId(file), { status: "id", id: "sess_legacy" });
  await rm(dir, { recursive: true, force: true });
});
