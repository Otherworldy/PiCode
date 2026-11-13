import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { JsonlEntryMetadata } from "./jsonl-entry-metadata.js";
import { readPiJsonl } from "./jsonl-history.js";
import { readStoredSessionTitle } from "./jsonl-title-reader.js";

async function check(content: string, expected: string | null) {
  const root = await mkdtemp(join(tmpdir(), "pi-title-reader-"));
  try {
    const file = join(root, "session.jsonl");
    await writeFile(file, content);
    assert.equal(await readStoredSessionTitle(file), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("title reader agrees with actual Pi names and the host's active branch projection", async () => {
  const manager = SessionManager.inMemory("/work");
  const first = manager.appendMessage({ role: "user", content: "原文", timestamp: 1 });
  const active = manager.appendSessionInfo("  活动\r\n分支  ");
  manager.appendMessage({ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: 2 });
  manager.branch(first);
  manager.appendSessionInfo("较新的放弃分支名称");
  manager.branch(active);
  manager.appendMessage({ role: "user", content: "继续", timestamp: 3 });
  const content = manager
    .getEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  // Pi 的 getSessionName 取全文件最后一个名字；Host 重放按当前叶子父链取名，保持现有边界。
  assert.equal(manager.getSessionName(), "较新的放弃分支名称");
  assert.equal(readPiJsonl(content).summary?.title, "活动 分支");
  await check(content, "活动 分支");
});

test("metadata projection validates discarded payloads and handles every string split", () => {
  const record =
    '{"id":"a\\u4e2d😀","parentId":"p\\\\q","type":"session_info",' +
    '"name":"  中文\\n 名称 ","data":{"x":[-1.2e+3,true,false,null,{"name":"ignored"}]}}';
  const expected = new JsonlEntryMetadata();
  expected.write(record);
  const metadata = expected.finish();
  assert.ok(metadata);
  assert.equal(metadata.title, "中文 名称");
  for (let split = 0; split <= record.length; split += 1) {
    const parser = new JsonlEntryMetadata();
    parser.write(record.slice(0, split));
    parser.write(record.slice(split));
    assert.deepEqual(parser.finish(), metadata, `split ${split}`);
  }
  const equivalent = new JsonlEntryMetadata();
  equivalent.write(JSON.stringify(JSON.parse(record)));
  assert.deepEqual(equivalent.finish(), metadata);
  for (const payload of [
    "[1,]",
    '{"x":}',
    "[01]",
    "[1.]",
    "[1e+]",
    "[tru]",
    "[1true]",
    "[-null]",
    '"\\x"',
    '"\t"',
  ]) {
    const parser = new JsonlEntryMetadata();
    parser.write(`{"type":"session_info","name":"invalid","data":${payload}}`);
    assert.equal(parser.finish(), null, payload);
  }
});

test("title reader validates malformed large tails instead of changing the leaf", async () => {
  const base = [
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "原文" } },
    { type: "session_info", id: "n", parentId: "u", name: "有效名称" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await check(
    `${base}\n{"type":"session_info","id":"bad","parentId":"u","name":"非法名称","data":"${"x".repeat(2 * 1024 * 1024)}",}`,
    "有效名称",
  );
});

test("title reader does not cap long names and handles whitespace at the title clip boundary", async () => {
  for (const title of [
    "a".repeat(60) + " b",
    "/" + "a".repeat(100_000) + " b",
    "中".repeat(100_000),
    "/" + "a".repeat(100_000),
  ]) {
    const content = JSON.stringify({ type: "session_info", name: title });
    await check(content, readPiJsonl(content).summary?.title ?? null);
  }
});

test("non-name entries and invalid duplicate fields cannot supply a title", async () => {
  const content =
    '{"type":"session_info","name":"valid"}\n' +
    '{"type":"message","name":"not metadata"}\n' +
    '{"type":"session_info","name":"bad","name":{}}\n' +
    '{"type":"session_info","name":"bad","type":false}\n' +
    '[]\ntrue\n{"type":"session_info","name":';
  await check(content, "valid");
});

test("missing title files retain the read failure fallback", async () => {
  assert.equal(
    await readStoredSessionTitle(join(tmpdir(), "no-such-title-session.jsonl")),
    undefined,
  );
});
