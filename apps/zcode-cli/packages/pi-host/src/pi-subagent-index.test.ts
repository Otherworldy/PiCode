import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { trackLiveSubagent } from "./live-subagents.js";
import { listPiSubagentChildren, subagentRoleFromSessionText } from "./pi-subagent-index.js";

test("subagent role comes from the system prompt, not the tool name", () => {
  assert.equal(
    subagentRoleFromSessionText("You are reviewer. Inspect the change."),
    "reviewer",
  );
  assert.equal(subagentRoleFromSessionText("You are evidence-auditor. Check claims."), "evidence-auditor");
  assert.equal(subagentRoleFromSessionText("no role here"), "");
});

test("a child jsonl keeps the task title and reports the agent role", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-index-"));
  const parentFile = join(root, "parent.jsonl");
  await writeFile(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}\n`,
  );
  const childDir = join(root, "parent", "picode-subagent");
  await mkdir(childDir, { recursive: true });
  const childFile = join(childDir, "child.jsonl");
  await writeFile(
    childFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child-role",
        cwd: root,
        timestamp: "2026-09-22T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "system",
          content: "",
          sections: { addendum: "You are reviewer. Inspect the change." },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Repo: D:/Study/Code/Github/ZCode audit the desktop host" }],
        },
      }),
    ].join("\n"),
  );

  const children = await listPiSubagentChildren({
    parentSessionFile: parentFile,
    parentSessionId: "parent",
  });
  assert.equal(children[0]?.subagentType, "reviewer");
  assert.match(children[0]?.title ?? "", /ZCode/);

  await writeFile(`${childFile}.role`, "scout\n");
  const named = await listPiSubagentChildren({
    parentSessionFile: parentFile,
    parentSessionId: "parent",
  });
  assert.equal(named[0]?.subagentType, "scout");
});

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

test("live children stay running and a dead file with no assistant text does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-index-"));
  const parentFile = join(root, "parent.jsonl");
  await writeFile(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}\n`,
  );
  const childDir = join(root, "parent");
  await mkdir(childDir, { recursive: true });
  const writeChild = async (id: string, assistant: string | undefined) => {
    await writeFile(
      join(childDir, `${id}.jsonl`),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          cwd: root,
          timestamp: "2026-09-22T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "scout" }] },
        }),
        ...(assistant
          ? [
              JSON.stringify({
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: assistant }] },
              }),
            ]
          : []),
      ].join("\n"),
    );
  };
  await writeChild("child-live", "I'll start by mapping the target directories.");
  await writeChild("child-dead", undefined);
  const release = trackLiveSubagent("child-live", {
    abort() {},
    getModel: () => ({ provider: "", model: "", thought: "" }),
    setModel: async () => false,
  });
  try {
    const children = await listPiSubagentChildren({
      parentSessionFile: parentFile,
      parentSessionId: "parent",
    });
    const byId = new Map(children.map((child) => [child.childSessionId, child]));
    assert.equal(byId.get("child-live")?.status, "running");
    assert.equal(byId.get("child-live")?.endedAt, undefined);
    assert.equal(byId.get("child-dead")?.status, "success");
  } finally {
    release();
  }
  const finished = await listPiSubagentChildren({
    parentSessionFile: parentFile,
    parentSessionId: "parent",
  });
  assert.equal(finished.find((child) => child.childSessionId === "child-live")?.status, "success");
});
