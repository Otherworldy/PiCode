import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TurnId } from "@picode/contracts";
import { HostSessionRegistry, type HostedSession, type PiSessionPort } from "@picode/pi-host";
import type { SessionOwner } from "./session-owner.js";
import {
  applySessionFileRewind,
  previewSessionFileRewind,
  readSessionAttachment,
  writeSessionAttachment,
} from "./session-files.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-session-files-"));
  const registry = new HostSessionRegistry({
    storageRoot: join(root, "meta"),
    nativeSessionsRoot: join(root, "sessions"),
    async createSession(input) {
      const pi: PiSessionPort = {
        sessionId: input.sessionId,
        isStreaming: false,
        isIdle: true,
        async prompt() {
          return true;
        },
        async steer() {},
        async followUp() {},
        async abort() {},
        async compact() {},
        subscribe() {
          return () => {};
        },
        dispose() {},
      };
      return pi;
    },
  });
  const sessions: HostedSession[] = [];
  return {
    root,
    async record(cwd = root): Promise<SessionOwner & { hosted: HostedSession }> {
      const hosted = await registry.create({
        sessionId: `files-${sessions.length}`,
        workspacePath: root,
      });
      sessions.push(hosted);
      // 保留真实 Registry 能力，仅指定本测试关注的执行目录（不测试 worktree 准入）。
      return { hosted: { ...hosted, cwd } };
    },
    async close() {
      await Promise.all(sessions.map((session) => session.dispose()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fileTurn(hosted: HostedSession, path: string, kind: "edit" | "write") {
  hosted.projector.apply({ type: "agent_start" });
  hosted.projector.apply({
    type: "tool_execution_start",
    toolCallId: "file-1",
    toolName: kind,
    args:
      kind === "edit"
        ? { path, edits: [{ oldText: "old", newText: "new" }] }
        : { path, content: "new\n" },
  });
  hosted.projector.apply({
    type: "tool_execution_end",
    toolCallId: "file-1",
    toolName: kind,
    result: { content: [{ type: "text", text: "ok" }] },
  });
  hosted.projector.apply({ type: "agent_end" });
  const header = hosted.projector
    .getSnapshot()
    .rows.window.find((row) => row.kind === "turnHeader");
  assert.ok(header && header.kind === "turnHeader");
  return header.turnId as TurnId;
}

for (const kind of ["edit", "write"] as const) {
  test(`relative ${kind} rewind uses hosted cwd and leaves matching workspace file untouched`, async () => {
    const f = await fixture();
    try {
      const cwd = join(f.root, "worktree", "subdir");
      await mkdir(cwd, { recursive: true });
      const rootFile = join(f.root, "same.txt");
      const cwdFile = join(cwd, "same.txt");
      await Promise.all([writeFile(rootFile, "new\n"), writeFile(cwdFile, "new\n")]);
      const record = await f.record(cwd);
      const targetTurnId = fileTurn(record.hosted, "same.txt", kind);
      const options = { targetTurnId, expandSuffix: true };
      await writeFile(cwdFile, "external\n");
      assert.equal((await previewSessionFileRewind(record, options)).canApply, false);
      await writeFile(cwdFile, "new\n");
      assert.equal((await previewSessionFileRewind(record, options)).canApply, true);
      const result = await applySessionFileRewind(record, {
        ...options,
        async commitAfterApply() {
          assert.equal(await readFile(rootFile, "utf8"), "new\n");
          if (kind === "edit") assert.equal(await readFile(cwdFile, "utf8"), "old\n");
          else await assert.rejects(readFile(cwdFile), { code: "ENOENT" });
        },
      });
      assert.equal(result.applied, true, result.response);
      assert.equal(await readFile(rootFile, "utf8"), "new\n");
      if (kind === "edit") assert.equal(await readFile(cwdFile, "utf8"), "old\n");
      else await assert.rejects(readFile(cwdFile), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });
}

test("absolute rewind paths remain independent of hosted cwd", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "subdir");
    await mkdir(cwd);
    const path = join(f.root, "absolute.txt");
    await writeFile(path, "new\n");
    const record = await f.record(cwd);
    const targetTurnId = fileTurn(record.hosted, path, "edit");
    assert.equal((await applySessionFileRewind(record, { targetTurnId })).applied, true);
    assert.equal(await readFile(path, "utf8"), "old\n");
  } finally {
    await f.close();
  }
});

for (const twoSessions of [false, true]) {
  test(`concurrent attachments at one timestamp preserve refs and bytes across ${twoSessions ? "two records" : "one record"}`, async (t) => {
    const f = await fixture();
    const refs = new Set<string>();
    try {
      const first = await f.record();
      const second = twoSessions ? await f.record() : first;
      const uploads = Array.from({ length: 8 }, (_, index) => ({
        record: index % 2 ? second : first,
        fileName: index % 2 ? "same?.png" : "same*.png",
        bytes: Uint8Array.from([index, 0, 255, 128]),
        mime: "image/png",
      }));
      // 只 mock Date.now，并在并发写入完成后立即还原，避免修改整个 Date 时钟。
      const now = t.mock.method(Date, "now", () => 1700000000000);
      const results = await Promise.allSettled(
        uploads.map(async (upload) => {
          const result = await writeSessionAttachment(upload.record, upload);
          refs.add(result.ref);
          return result;
        }),
      );
      now.mock.restore();
      const written = results.map((result) => {
        assert.equal(result.status, "fulfilled");
        return result.value;
      });
      assert.equal(refs.size, uploads.length);
      await Promise.all(
        written.map(async ({ ref }, index) => {
          const upload = uploads[index];
          const preview = await readSessionAttachment(upload.record, {
            ref,
            mime: upload.mime,
            maxBytes: 100,
          });
          assert.deepEqual(new Uint8Array(preview.bytes), upload.bytes);
          assert.equal(preview.mediaType, upload.mime);
          assert.deepEqual(new Uint8Array(await readFile(ref)), upload.bytes);
        }),
      );
    } finally {
      await Promise.all([...refs].map((ref) => rm(ref, { force: true })));
      await f.close();
    }
  });
}
