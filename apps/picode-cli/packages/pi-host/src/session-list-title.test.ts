import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readPiJsonl } from "./jsonl-history.js";
import { HostSessionRegistry } from "./session-registry.js";

const MIB = 1024 * 1024;
const stamp = "2026-01-02T03:04:05.000Z";
const header = {
  type: "session",
  version: 3,
  id: "child",
  timestamp: stamp,
  cwd: "/work",
  parentSession: "/sessions/parent.jsonl",
};
const user = {
  type: "message",
  id: "u1",
  parentId: null,
  timestamp: stamp,
  message: { role: "user", content: "用户原文" },
};
const name = (id: string, parentId: string | null, title: unknown) => ({
  type: "session_info",
  id,
  parentId,
  timestamp: stamp,
  name: title,
});
const payload = (id: string, parentId: string | null, size = MIB + 31) => ({
  type: "message",
  id,
  parentId,
  timestamp: stamp,
  message: { role: "assistant", content: "中".repeat(size) },
});
const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

async function check(content: string, expected: string | null) {
  const root = await mkdtemp(join(tmpdir(), "pi-host-cold-title-"));
  try {
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "native"),
      createSession: async () => {
        throw new Error("cold list must not open a runtime");
      },
    });
    const dir = join(root, "pi-host-sessions", Buffer.from("/work").toString("base64url"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, "2026-01-02_child.jsonl");
    await writeFile(file, content);
    const full = readPiJsonl(content).summary;
    assert.equal(full?.title ?? null, expected);
    const listed = await registry.list("/work");
    if (expected === null) {
      assert.equal(listed.length, 0);
      return;
    }
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.title, full?.title);
    assert.equal(listed[0]?.sessionId, "child");
    assert.equal(listed[0]?.parentSessionId, "parent");
    assert.equal(listed[0]?.cwd, "/work");
    assert.equal(listed[0]?.createdAt, Date.parse(stamp));
    assert.equal(
      listed[0]?.lastActivityAt,
      Buffer.byteLength(content) > MIB ? (await stat(file)).mtimeMs : Date.parse(stamp),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("cold list finds a new name beyond the first MiB", async () => {
  await check(
    jsonl([
      header,
      user,
      name("old", "u1", "旧标题"),
      payload("a1", "old"),
      name("new", "a1", "总结后的新标题"),
    ]),
    "总结后的新标题",
  );
});

test("cold list finds a name with more than a MiB on both sides", async () => {
  await check(
    jsonl([
      header,
      user,
      name("old", "u1", "旧标题"),
      payload("a1", "old"),
      name("new", "a1", "最新总结"),
      payload("a2", "new"),
    ]),
    "最新总结",
  );
});

test("cold list preserves UTF-8 across scan boundaries and skips malformed tails", async () => {
  const prefix = jsonl([header, user, name("old", "u1", "旧标题"), payload("a1", "old")]);
  const latest = JSON.stringify(name("new", "a1", "  中文标题\n  边界 😀  "));
  // 让一个中文字节落在从文件尾反向读取的 64 KiB 块边界上。
  const afterChineseByte = Buffer.byteLength(latest.slice(latest.indexOf("中文"))) - 1;
  const malformed = '\n{"type":"session_info","id":"cut","parentId":"new","name":"未完成';
  const padding = 64 * 1024 - ((afterChineseByte + Buffer.byteLength(malformed)) % (64 * 1024));
  await check(`${prefix}\n${latest}${" ".repeat(padding)}${malformed}`, "中文标题 边界 😀");
});

test("cold list follows the active branch through oversized message lines", async () => {
  await check(
    jsonl([
      header,
      user,
      name("active", "u1", "活动分支"),
      payload("a1", "active"),
      name("abandoned", "u1", "放弃分支的较新名称"),
      payload("a2", "a1"),
    ]),
    "活动分支",
  );
});

test("cold list removes a head name that is absent from the active branch", async () => {
  await check(
    jsonl([
      header,
      user,
      name("abandoned", "u1", "旧分支"),
      payload("a1", "u1"),
      payload("a2", "a1"),
    ]),
    "用户原文",
  );
});

test("cold list keeps sanitization and excludes invalid or control names", async () => {
  await check(
    jsonl([
      header,
      user,
      payload("a1", "u1"),
      name("good", "a1", `  新\n 名称 ${"长".repeat(80)}`),
      name("command", "good", " /compact "),
      name("blank", "command", " \n "),
      name("invalid", "blank", 42),
    ]),
    `新 名称 ${"长".repeat(54)}…`,
  );
});

test("cold list supports unlinked legacy names and a name after a head without a summary", async () => {
  await check(
    jsonl([
      header,
      { type: "custom", data: "x".repeat(MIB + 100) },
      { type: "session_info", name: "首次名称" },
      { type: "session_info", name: "/plan" },
    ]),
    "首次名称",
  );
});

test("cold list reads lineage fields after oversized payloads and ignores forged nested names", async () => {
  await check(
    jsonl([
      header,
      user,
      name("active", "u1", "活动名称"),
      name("side", "u1", "侧枝名称"),
      {
        message: { role: "assistant", content: "x".repeat(MIB + 100), name: "伪名称" },
        name: "不是 session_info",
        parentId: "active",
        id: "leaf",
        type: "message",
        timestamp: stamp,
      },
    ]),
    "活动名称",
  );
});

test("small files retain their existing title and metadata", async () => {
  await check(jsonl([header, user, name("small", "u1", "小会话")]), "小会话");
});
