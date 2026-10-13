import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  localAgentSystemPromptPath,
  prepareAgentSystemPromptWrite,
  remoteAgentSystemPromptPath,
  resolvePiAgentDir,
} from "@zcode/shared/node";
import {
  readAgentSystemPromptFile,
  writeAgentSystemPromptFile,
} from "../src/file/agentSystemPrompt.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-system-prompt-"));
}

test("global and project prompts resolve to Pi's SYSTEM.md paths", () => {
  assert.equal(
    resolvePiAgentDir({ PI_CODING_AGENT_DIR: "  /tmp/agent  " }, "/home/me"),
    "/tmp/agent",
  );
  assert.equal(resolvePiAgentDir({}, "/home/me").replaceAll("\\", "/"), "/home/me/.pi/agent");
  assert.equal(
    localAgentSystemPromptPath({ scope: "global", agentDir: "/tmp/agent" }).replaceAll("\\", "/"),
    "/tmp/agent/SYSTEM.md",
  );
  assert.equal(
    localAgentSystemPromptPath({
      scope: "project",
      rootPath: "/work/app",
      agentDir: "/tmp/agent",
    }).replaceAll("\\", "/"),
    "/work/app/.pi/SYSTEM.md",
  );
  assert.equal(remoteAgentSystemPromptPath("/srv/app/"), "/srv/app/.pi/SYSTEM.md");
  assert.equal(remoteAgentSystemPromptPath("/"), "/.pi/SYSTEM.md");
  assert.equal(
    localAgentSystemPromptPath({
      scope: "project",
      rootPath: "/work/app",
      agentDir: "/tmp/agent",
      kind: "append",
    }).replaceAll("\\", "/"),
    "/work/app/.pi/APPEND_SYSTEM.md",
  );
  assert.equal(remoteAgentSystemPromptPath("/srv/app/", "append"), "/srv/app/.pi/APPEND_SYSTEM.md");
  assert.equal(remoteAgentSystemPromptPath("/", "append"), "/.pi/APPEND_SYSTEM.md");
  assert.equal(prepareAgentSystemPromptWrite("  \n"), null);
  assert.equal(prepareAgentSystemPromptWrite("\uFEFFkeep"), "keep");
});

test("blank save deletes SYSTEM.md and a later read is empty", async () => {
  const root = await makeRoot();
  const agentDir = join(root, "agent");
  try {
    const written = await writeAgentSystemPromptFile({
      scope: "global",
      agentDir,
      content: "be brief",
    });
    assert.equal(written.exists, true);
    assert.equal(await readFile(join(agentDir, "SYSTEM.md"), "utf8"), "be brief");
    const cleared = await writeAgentSystemPromptFile({
      scope: "global",
      agentDir,
      content: " \n\t",
    });
    assert.equal(cleared.exists, false);
    assert.equal(cleared.content, "");
    await assert.rejects(stat(join(agentDir, "SYSTEM.md")));
    const read = await readAgentSystemPromptFile({ scope: "global", agentDir });
    assert.equal(read.exists, false);
    assert.equal(read.content, "");
    assert.equal(read.path, join(agentDir, "SYSTEM.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project append prompt writes APPEND_SYSTEM.md and leaves SYSTEM.md alone", async () => {
  const root = await makeRoot();
  try {
    await writeAgentSystemPromptFile({
      scope: "project",
      rootPath: root,
      agentDir: join(root, "unused-agent"),
      kind: "append",
      content: "project addendum",
    });
    assert.equal(await readFile(join(root, ".pi", "APPEND_SYSTEM.md"), "utf8"), "project addendum");
    await assert.rejects(stat(join(root, ".pi", "SYSTEM.md")));
    assert.equal(
      (
        await readAgentSystemPromptFile({
          scope: "project",
          rootPath: root,
          agentDir: root,
          kind: "append",
        })
      ).content,
      "project addendum",
    );
    const cleared = await writeAgentSystemPromptFile({
      scope: "project",
      rootPath: root,
      agentDir: root,
      kind: "append",
      content: "  ",
    });
    assert.equal(cleared.exists, false);
    await assert.rejects(stat(join(root, ".pi", "APPEND_SYSTEM.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project prompt does not write the global file", async () => {
  const root = await makeRoot();
  try {
    await writeAgentSystemPromptFile({
      scope: "project",
      rootPath: root,
      agentDir: join(root, "unused-agent"),
      content: "project rules",
    });
    assert.equal(await readFile(join(root, ".pi", "SYSTEM.md"), "utf8"), "project rules");
    await assert.rejects(stat(join(root, "unused-agent", "SYSTEM.md")));
    assert.equal(
      (await readAgentSystemPromptFile({ scope: "project", rootPath: root, agentDir: root }))
        .content,
      "project rules",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized prompt is rejected and does not create a file", async () => {
  const root = await makeRoot();
  try {
    await assert.rejects(
      writeAgentSystemPromptFile({
        scope: "project",
        rootPath: root,
        agentDir: root,
        content: "x".repeat(256 * 1024 + 1),
      }),
      /too large/,
    );
    await assert.rejects(stat(join(root, ".pi", "SYSTEM.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
