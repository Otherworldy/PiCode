import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyWorkspaceMemoryPatch,
  buildWorkspaceMemorySection,
  createWorkspaceMemoryExtension,
  formatWorkspaceMemoryIndex,
  parseWorkspaceMemoryPatch,
  readWorkspaceMemoryIndex,
  shouldRunWorkspaceMemoryExtraction,
} from "./workspace-memory.js";
import {
  buildWorkspaceMemoryExtractionPrompt,
  buildWorkspaceMemoryTranscript,
  containsDirectWorkspaceMemoryWrite,
  containsEligibleWorkspaceMemoryUserProse,
  readWorkspaceMemoryManifest,
} from "./workspace-memory-extraction.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-memory-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

test("index over budget is truncated with a warning instead of being dropped", () => {
  const long = Array.from({ length: 260 }, () => `- [A](a.md) — ${"x".repeat(120)}`).join("\n");
  const formatted = formatWorkspaceMemoryIndex(long);
  assert.match(formatted, /WARNING: MEMORY\.md is 260 lines/);
  assert.ok(formatted.split("\n").length < 210);
  // 未超预算时原样返回。
  assert.equal(formatWorkspaceMemoryIndex("- [A](a.md) — a"), "- [A](a.md) — a");
  // 手写 frontmatter 不占注入预算。
  assert.equal(
    formatWorkspaceMemoryIndex("---\ntitle: x\n---\n- [A](a.md) — a"),
    "- [A](a.md) — a",
  );
});

test("patch parser accepts fenced JSON and rejects unsafe file names", () => {
  const valid = parseWorkspaceMemoryPatch(
    '```json\n{"writes":[{"file":"workflow.md","content":"# Workflow"}],"index":"- [Workflow](workflow.md) — flow"}\n```',
  );
  assert.deepEqual(valid, {
    writes: [{ file: "workflow.md", content: "# Workflow" }],
    appends: [],
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

test("appends extend an existing file without a full rewrite", async () => {
  await withRoot(async (root) => {
    await applyWorkspaceMemoryPatch(root, {
      writes: [{ file: "workflow.md", content: "# Workflow\n" }],
      appends: [],
      deletes: [],
      index: "- [Workflow](workflow.md) — flow\n",
    });
    await applyWorkspaceMemoryPatch(root, {
      writes: [],
      appends: [{ file: "workflow.md", content: "extra fact" }],
      deletes: [],
    });
    assert.equal(await readFile(join(root, "workflow.md"), "utf-8"), "# Workflow\nextra fact");
  });
});

test("writes are ignored for files whose preview was truncated", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "long.md"), "original\n");
    await applyWorkspaceMemoryPatch(
      root,
      { writes: [{ file: "long.md", content: "replaced\n" }], appends: [], deletes: [] },
      { truncatedFiles: ["long.md"] },
    );
    assert.equal(await readFile(join(root, "long.md"), "utf-8"), "original\n");
  });
});

test("applying a patch writes memory files and the index", async () => {
  await withRoot(async (root) => {
    await applyWorkspaceMemoryPatch(root, {
      writes: [{ file: "workflow.md", content: "# Workflow\n" }],
      appends: [],
      deletes: [],
      index: "- [Workflow](workflow.md) — flow\n",
    });
    assert.equal(await readWorkspaceMemoryIndex(root), "- [Workflow](workflow.md) — flow\n");
    assert.deepEqual(
      (await readWorkspaceMemoryManifest(root)).map((entry) => [entry.name, entry.preview]),
      [["workflow.md", "# Workflow\n"]],
    );

    await applyWorkspaceMemoryPatch(root, {
      writes: [],
      appends: [],
      deletes: ["workflow.md"],
      index: "",
    });
    assert.deepEqual(await readWorkspaceMemoryManifest(root), []);
    assert.equal(await readFile(join(root, "workflow.md"), "utf-8").catch(() => null), null);
  });
});

test("oversized index is truncated for injection instead of being dropped", async () => {
  await withRoot(async (root) => {
    const line = `${"x".repeat(120)}\n`;
    await writeFile(join(root, "MEMORY.md"), line.repeat(260));
    // 原文仍然可读：1 MiB 读取上限只防超大文件。
    assert.equal((await readWorkspaceMemoryIndex(root))?.length, 260 * line.length);
    const section = buildWorkspaceMemorySection(root, await readWorkspaceMemoryIndex(root));
    assert.match(section, /WARNING: MEMORY\.md is 260 lines/);
    assert.ok(section.split("\n").length < 215);
  });
});

test("index over budget is not persisted; a compact rebuild replaces it", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "node.md"),
      "---\nname: Node\ndescription: use Node 24\ntype: project\n---\n\nbody\n",
    );
    const bloated = Array.from({ length: 260 }, () => `- ${"y".repeat(150)}`).join("\n");
    await applyWorkspaceMemoryPatch(root, {
      writes: [],
      appends: [],
      deletes: [],
      index: bloated,
    });
    const written = (await readWorkspaceMemoryIndex(root)) ?? "";
    assert.notEqual(written, bloated);
    assert.match(written, /- \[Node\]\(node\.md\) — use Node 24/);
  });
});

test("manifest previews are capped and marked truncated", async () => {
  await withRoot(async (root) => {
    const body = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    await writeFile(
      join(root, "long.md"),
      `---\nname: Long\ndescription: a long memory\n---\n${body}`,
    );
    const [entry] = await readWorkspaceMemoryManifest(root);
    assert.equal(entry?.name, "long.md");
    assert.equal(entry?.description, "a long memory");
    assert.equal(entry?.truncated, true);
    assert.equal(entry?.preview.split("\n").length, 30);
    assert.doesNotMatch(entry?.preview ?? "", /line 40/);

    const prompt = buildWorkspaceMemoryExtractionPrompt({
      transcript: "User: hi",
      index: "- [Long](long.md) — a long memory",
      manifest: await readWorkspaceMemoryManifest(root),
    });
    assert.match(prompt, /### long\.md \(truncated,/);
    // 抽取输入只带预览，不再拼全文。
    assert.doesNotMatch(prompt, /line 40/);
  });
});

test("extraction is skipped when the main model already wrote memory this turn", () => {
  const root = join(tmpdir(), "zcode-memory-root");
  const rows = [
    {
      kind: "toolCall",
      toolName: "Write",
      input: { path: join(root, "a.md") },
    },
  ];
  assert.equal(containsDirectWorkspaceMemoryWrite(rows, root), true);
  assert.equal(
    containsDirectWorkspaceMemoryWrite(
      [{ kind: "toolCall", toolName: "Write", input: { path: "/other/a.md" } }],
      root,
    ),
    false,
  );
  assert.equal(
    containsDirectWorkspaceMemoryWrite(
      [{ kind: "toolCall", toolName: "Read", input: { path: join(root, "a.md") } }],
      root,
    ),
    false,
  );
});

test("extraction is skipped when the turn has no real user prose", () => {
  assert.equal(
    containsEligibleWorkspaceMemoryUserProse([
      { kind: "userInput", text: "好", origin: "realUser" },
    ]),
    false,
  );
  assert.equal(
    containsEligibleWorkspaceMemoryUserProse([
      { kind: "userInput", text: "please remember this", origin: "realUser" },
    ]),
    true,
  );
  assert.equal(
    containsEligibleWorkspaceMemoryUserProse([
      { kind: "userInput", text: "请记住这个项目的部署方式", origin: "realUser" },
    ]),
    true,
  );
  // 后台结果不算用户输入。
  assert.equal(
    containsEligibleWorkspaceMemoryUserProse([
      { kind: "userInput", text: "background finished successfully", origin: "backgroundResult" },
    ]),
    false,
  );
});

test("extraction is gated by turn count or elapsed time", () => {
  // 首个 turn 且未到时间窗：不抽。
  assert.equal(shouldRunWorkspaceMemoryExtraction({ turnsSinceLast: 1, elapsedMs: 60_000 }), false);
  // 攒够 3 个 turn：抽。
  assert.equal(shouldRunWorkspaceMemoryExtraction({ turnsSinceLast: 3, elapsedMs: 60_000 }), true);
  // 只 1 个 turn 但已过 10 分钟：也抽。
  assert.equal(
    shouldRunWorkspaceMemoryExtraction({ turnsSinceLast: 1, elapsedMs: 10 * 60_000 }),
    true,
  );
});

test("patch without index rebuilds it from written items", async () => {
  await withRoot(async (root) => {
    await applyWorkspaceMemoryPatch(root, {
      writes: [
        {
          file: "build.md",
          content: [
            "---",
            "name: Build",
            "description: run pnpm build",
            "type: project",
            "---",
            "",
            "body",
          ].join("\n"),
        },
      ],
      appends: [],
      deletes: [],
    });
    assert.match(
      (await readWorkspaceMemoryIndex(root)) ?? "",
      /- \[Build\]\(build\.md\) — run pnpm build/,
    );
  });
});

test("memory extension appends the index to the rendered prompt and clears when disabled", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "MEMORY.md"), "- [A](a.md) — a");
    const handlers: Array<(event: unknown) => Promise<void> | void> = [];
    const pi = {
      on: (name: string, handler: (event: unknown) => Promise<void> | void) => {
        if (name === "before_agent_start") handlers.push(handler);
      },
    };
    createWorkspaceMemoryExtension({ root, enabled: true })(pi as never);
    const options: Record<string, unknown> = {};
    await handlers[0]?.({ systemPrompt: "BASE PROMPT", systemPromptOptions: options });
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
    createWorkspaceMemoryExtension({ root, enabled: false })(disabledPi as never);
    const disabledOptions: Record<string, unknown> = { forceSystemPrompt: "stale" };
    await disabledHandlers[0]?.({ systemPrompt: "BASE", systemPromptOptions: disabledOptions });
    assert.equal(disabledOptions.forceSystemPrompt, undefined);
  });
});

test("stale extraction snapshot does not overwrite a newer index", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "MEMORY.md"), "newer\n");
    await applyWorkspaceMemoryPatch(
      root,
      { writes: [], appends: [], deletes: [], index: "stale-patch\n" },
      { expectedIndex: "older\n" },
    );
    assert.equal(await readFile(join(root, "MEMORY.md"), "utf-8"), "newer\n");
  });
});
