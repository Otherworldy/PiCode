import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyWorkspaceMemoryPatch,
  buildWorkspaceMemorySection,
  createWorkspaceMemoryExtension,
  buildWorkspaceMemoryTranscript,
  parseWorkspaceMemoryPatch,
  readWorkspaceMemoryFiles,
  readWorkspaceMemoryIndex,
} from "./workspace-memory.js";

test("workspace memory section includes root and index", () => {
  const section = buildWorkspaceMemorySection("/tmp/project/.pi/memory", "- [A](a.md) — a");
  assert.match(section, /\/tmp\/project\/\.pi\/memory/);
  assert.match(section, /- \[A\]\(a\.md\)/);
});

test("transcript keeps only user and assistant text", () => {
  const transcript = buildWorkspaceMemoryTranscript([
    { kind: "userInput", text: "do the thing" },
    { kind: "toolCall", text: "ignored" },
    { kind: "assistantText", text: "done" },
  ]);
  assert.equal(transcript, "User: do the thing\n\nAssistant: done");
});

test("patch parser accepts fenced JSON and rejects unsafe file names", () => {
  const valid = parseWorkspaceMemoryPatch(
    '```json\n{"writes":[{"file":"workflow.md","content":"# Workflow"}],"index":"- [Workflow](workflow.md) — flow"}\n```',
  );
  assert.deepEqual(valid, {
    writes: [{ file: "workflow.md", content: "# Workflow" }],
    deletes: [],
    index: "- [Workflow](workflow.md) — flow",
  });

  assert.equal(
    parseWorkspaceMemoryPatch('{"writes":[{"file":"../escape.md","content":"x"}]}'),
    null,
  );
  assert.equal(parseWorkspaceMemoryPatch('{"writes":[{"file":"MEMORY.md","content":"x"}]}'), null);
  assert.equal(parseWorkspaceMemoryPatch('{"writes":[{"file":"UPPER.md","content":"x"}]}'), null);
  assert.equal(parseWorkspaceMemoryPatch("not json"), null);
});

test("applying a patch writes memory files and the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-"));
  try {
    await applyWorkspaceMemoryPatch(root, {
      writes: [{ file: "workflow.md", content: "# Workflow\n" }],
      deletes: [],
      index: "- [Workflow](workflow.md) — flow\n",
    });
    assert.equal(await readWorkspaceMemoryIndex(root), "- [Workflow](workflow.md) — flow\n");
    assert.deepEqual(await readWorkspaceMemoryFiles(root), [
      { name: "workflow.md", content: "# Workflow\n" },
    ]);

    await applyWorkspaceMemoryPatch(root, {
      writes: [],
      deletes: ["workflow.md"],
      index: "",
    });
    assert.deepEqual(await readWorkspaceMemoryFiles(root), []);
    assert.equal(await readFile(join(root, "workflow.md"), "utf-8").catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index reader ignores oversized content", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-index-"));
  try {
    await writeFile(join(root, "MEMORY.md"), "x".repeat(33 * 1024));
    assert.equal(await readWorkspaceMemoryIndex(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch without index rebuilds it from written items", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-rebuild-"));
  try {
    await applyWorkspaceMemoryPatch(root, {
      writes: [
        {
          file: "build.md",
          content: `---
name: Build
description: run pnpm build
type: project
---

body`,
        },
      ],
      deletes: [],
    });
    assert.match(
      (await readWorkspaceMemoryIndex(root)) ?? "",
      /- \[Build\]\(build\.md\) — run pnpm build/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory extension appends the index to the rendered prompt and clears when disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-extension-"));
  try {
    await writeFile(join(root, "MEMORY.md"), "- [A](a.md) — a");
    const handlers: Array<(event: unknown) => Promise<void> | void> = [];
    const pi = {
      on: (name: string, handler: (event: unknown) => Promise<void> | void) => {
        if (name === "before_agent_start") handlers.push(handler);
      },
    };
    createWorkspaceMemoryExtension({
      root,
      enabled: true,
    })(pi as never);
    const options: Record<string, unknown> = {};
    await handlers[0]?.({
      systemPrompt: "BASE PROMPT",
      systemPromptOptions: options,
    });
    assert.match(String(options.forceSystemPrompt), /BASE PROMPT/);
    assert.match(String(options.forceSystemPrompt), /- \[A\]\(a\.md\)/);

    // 上一轮的 force prompt 已带记忆段时，下一轮只保留一份。
    const repeatedOptions: Record<string, unknown> = {};
    await handlers[0]?.({
      systemPrompt: `${String(options.forceSystemPrompt)}\n\nSTALE TAIL`,
      systemPromptOptions: repeatedOptions,
    });
    const repeated = String(repeatedOptions.forceSystemPrompt);
    assert.equal(
      repeated.split("You have a persistent file-based workspace memory at").length - 1,
      1,
    );
    assert.doesNotMatch(repeated, /STALE TAIL/);

    const disabledHandlers: Array<(event: unknown) => Promise<void> | void> = [];
    const disabledPi = {
      on: (_name: string, handler: (event: unknown) => Promise<void> | void) => {
        disabledHandlers.push(handler);
      },
    };
    createWorkspaceMemoryExtension({
      root,
      enabled: false,
    })(disabledPi as never);
    const disabledOptions: Record<string, unknown> = { forceSystemPrompt: "stale" };
    await disabledHandlers[0]?.({
      systemPrompt: "BASE",
      systemPromptOptions: disabledOptions,
    });
    assert.equal(disabledOptions.forceSystemPrompt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale extraction snapshot does not overwrite a newer index", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-index-race-"));
  try {
    await writeFile(join(root, "MEMORY.md"), "newer\n");
    await applyWorkspaceMemoryPatch(
      root,
      { writes: [], deletes: [], index: "stale-patch\n" },
      { expectedIndex: "older\n" },
    );
    assert.equal(await readFile(join(root, "MEMORY.md"), "utf-8"), "newer\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
