import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPiSubagentChildren } from "./pi-subagent-index.js";

test("lists a Pi child jsonl beside the parent session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-index-"));
  const parentFile = join(root, "parent.jsonl");
  await writeFile(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}\n`,
  );
  const childDir = join(root, "parent", "run-1");
  await mkdir(childDir, { recursive: true });
  await writeFile(
    join(childDir, "child.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "child-1", cwd: root, timestamp: "2026-09-22T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "scout the panel" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n"),
  );

  const children = await listPiSubagentChildren({
    parentSessionFile: parentFile,
    parentSessionId: "parent",
  });

  assert.equal(children.length, 1);
  assert.equal(children[0]?.childSessionId, "child-1");
  assert.equal(children[0]?.status, "success");
  assert.match(children[0]?.title ?? "", /scout/);
});

test("lists a child written beside the unused pre-create filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-index-"));
  const parentFile = join(root, "2026-09-22T00-00-02-000Z_parent.jsonl");
  await writeFile(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}
`,
  );
  const childDir = join(root, "2026-09-22T00-00-01-000Z_parent", "zcode-subagent");
  await mkdir(childDir, { recursive: true });
  await writeFile(
    join(childDir, "child.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "child-2", cwd: root, timestamp: "2026-09-22T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "other stem" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "from the other stem" }] },
      }),
    ].join("\n"),
  );

  const children = await listPiSubagentChildren({
    parentSessionFile: parentFile,
    parentSessionId: "parent",
  });
  assert.equal(children[0]?.childSessionId, "child-2");
});
