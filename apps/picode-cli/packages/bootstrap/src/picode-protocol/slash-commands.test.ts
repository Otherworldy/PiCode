import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listProtocolSlashCommands } from "./slash-commands.js";

test("a live session snapshot does not hide a prompt file saved later", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "slash-catalog-"));
  await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "prompts", "review.md"),
    "---\ndescription: Review the diff\n---\nReview it.\n",
  );

  const commands = await listProtocolSlashCommands({
    workingDirectory: cwd,
    piCommands: [
      { name: "compact", description: "Compact", inputHint: "/compact", source: "builtin" },
      { name: "subagents", description: "Run subagents", inputHint: "/subagents", source: "extension" },
    ],
  });

  const review = commands.find((command) => command.name === "review");
  assert.equal(review?.description, "Review the diff");
  assert.equal(review?.source, "custom");
  assert.ok(commands.some((command) => command.name === "subagents"));
});
