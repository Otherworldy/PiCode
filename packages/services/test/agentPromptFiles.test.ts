import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentPromptFileNameFromLabel,
  remoteAgentPromptPath,
} from "@zcode/shared/node";
import {
  deleteAgentPromptFile,
  listAgentPromptFiles,
  readAgentPromptFile,
  writeAgentPromptFile,
} from "../src/file/agentPromptFiles.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-prompts-"));
}

test("prompt names stay a single markdown file", () => {
  assert.equal(agentPromptFileNameFromLabel("Review"), "Review.md");
  assert.equal(agentPromptFileNameFromLabel("ship.md"), "ship.md");
  assert.equal(remoteAgentPromptPath("/srv/app/", "review.md"), "/srv/app/.pi/prompts/review.md");
  assert.throws(() => agentPromptFileNameFromLabel("../SYSTEM"), /Invalid prompt name/);
  assert.throws(() => remoteAgentPromptPath("/srv/app", "../x.md"), /Invalid prompt name/);
});

test("project prompts are many files under .pi/prompts and do not touch global", async () => {
  const root = await makeRoot();
  const agentDir = join(root, "agent");
  try {
    await mkdir(join(root, ".pi", "prompts", "extra"), { recursive: true });
    await writeFile(join(root, ".pi", "prompts", "extra", "nested.md"), "skip me", "utf8");
    await writeAgentPromptFile({
      scope: "project",
      rootPath: root,
      agentDir,
      name: "review.md",
      content: "look closely",
    });
    await writeAgentPromptFile({
      scope: "project",
      rootPath: root,
      agentDir,
      name: "ship.md",
      content: "ship it",
    });
    const listed = await listAgentPromptFiles({ scope: "project", rootPath: root, agentDir });
    assert.deepEqual(listed.files, ["review.md", "ship.md"]);
    assert.equal(
      (await readAgentPromptFile({ scope: "project", rootPath: root, agentDir, name: "ship.md" }))
        .content,
      "ship it",
    );
    await deleteAgentPromptFile({ scope: "project", rootPath: root, agentDir, name: "review.md" });
    assert.deepEqual(
      (await listAgentPromptFiles({ scope: "project", rootPath: root, agentDir })).files,
      ["ship.md"],
    );
    assert.deepEqual(await listAgentPromptFiles({ scope: "global", agentDir }), {
      directory: join(agentDir, "prompts"),
      files: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
