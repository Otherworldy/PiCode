import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  WORKSPACE_MEMORY_EXPIRED_DIR_NAME,
  parseWorkspaceMemoryFrontmatter,
  pruneExpiredWorkspaceMemories,
  reconcileWorkspaceMemoryIndex,
  resolveWorkspaceMemoryExpiry,
} from "@zcode/shared/node";
import {
  buildWorkspaceMemoryExtractionPrompt,
  buildWorkspaceMemoryTranscript,
  lastWorkspaceMemoryTurnId,
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

test("transcript covers every turn since the last extraction", () => {
  const rows = [
    { kind: "turnHeader", turnId: "t1" },
    { kind: "userInput", turnId: "t1", text: "部署用 docker compose" },
    { kind: "assistantText", turnId: "t1", text: "好" },
    { kind: "turnHeader", turnId: "t2" },
    { kind: "userInput", turnId: "t2", text: "Node 版本锁 24" },
    { kind: "assistantText", turnId: "t2", text: "已记" },
    { kind: "turnHeader", turnId: "t3" },
    { kind: "userInput", turnId: "t3", text: "测试用 pnpm" },
  ];
  // 首次抽取（无游标）拿全部 turn，不能只剩最后一条。
  const all = buildWorkspaceMemoryTranscript(rows);
  assert.match(all, /docker compose/);
  assert.match(all, /Node 版本锁 24/);
  assert.match(all, /测试用 pnpm/);
  // 已抽过 t2：只留下 t3，不重复抽。
  const after = buildWorkspaceMemoryTranscript(rows, { afterTurnId: "t2" });
  assert.doesNotMatch(after, /docker compose/);
  assert.doesNotMatch(after, /Node 版本锁 24/);
  assert.match(after, /测试用 pnpm/);
  // 游标已经滚出窗口：退化为整窗重抽，宁可多抽不漏抽。
  const rolled = buildWorkspaceMemoryTranscript(rows, { afterTurnId: "t0" });
  assert.match(rolled, /docker compose/);
  assert.equal(lastWorkspaceMemoryTurnId(rows), "t3");
  // 超长时丢最早内容，保留最近的。
  const capped = buildWorkspaceMemoryTranscript(rows, { maxChars: 20 });
  assert.match(capped, /earlier turns omitted/);
  assert.match(capped, /pnpm/);
});

test("index reconciliation drops dead links and adds missing pointers", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "kept.md"),
      "---\nname: Kept\ndescription: 还在\ntype: project\n---\n\nbody\n",
    );
    await writeFile(
      join(root, "orphan.md"),
      "---\nname: Orphan\ndescription: 新条目\n---\n\nbody\n",
    );
    await writeFile(
      join(root, "MEMORY.md"),
      "# 索引\n- [Kept](kept.md) — 还在\n- [Gone](gone.md) — 已删\n\n尾注\n",
    );
    await reconcileWorkspaceMemoryIndex(root);
    const index = (await readWorkspaceMemoryIndex(root)) ?? "";
    assert.match(index, /索引/); // 非指针行原样保留
    assert.match(index, /kept\.md/);
    assert.doesNotMatch(index, /gone\.md/); // 死链被剔除
    assert.match(index, /- \[Orphan\]\(orphan\.md\) — 新条目/); // 孤儿补上指针
    assert.match(index, /尾注/);
    // 幂等：再对账一次内容不变。
    const once = index;
    await reconcileWorkspaceMemoryIndex(root);
    assert.equal(await readWorkspaceMemoryIndex(root), once);
  });
});

test("index reconciliation leaves projects without an index alone", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "a.md"), "---\nname: A\n---\n");
    assert.equal(await reconcileWorkspaceMemoryIndex(root), null);
    await assert.rejects(readFile(join(root, "MEMORY.md"), "utf-8"));
  });
});

test("patch that writes a file without an index still gets a pointer", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "MEMORY.md"), "- [Old](old.md) — 旧\n");
    await writeFile(join(root, "old.md"), "---\nname: Old\ndescription: 旧\n---\n");
    const patch = parseWorkspaceMemoryPatch(
      JSON.stringify({
        writes: [
          {
            file: "fresh.md",
            content: "---\nname: Fresh\ndescription: 新事实\n---\n",
          },
        ],
        deletes: ["old.md"],
      }),
    );
    assert.ok(patch);
    await applyWorkspaceMemoryPatch(root, patch);
    const index = (await readWorkspaceMemoryIndex(root)) ?? "";
    assert.match(index, /- \[Fresh\]\(fresh\.md\) — 新事实/);
    assert.doesNotMatch(index, /old\.md/);
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

test("frontmatter defaults stay lenient for old or broken files", () => {
  const plain = parseWorkspaceMemoryFrontmatter("no frontmatter at all");
  assert.equal(plain.category, "project");
  assert.equal(plain.type, "fact");
  assert.equal(plain.source, "assistant");
  assert.equal(plain.confirmed, false);
  assert.equal(plain.lastConfirmed, undefined);

  const broken = parseWorkspaceMemoryFrontmatter(
    [
      "---",
      "name: A",
      "category: nonsense",
      "type: Nonsense",
      "confirmed: yes",
      "lastConfirmed: 14/02/2026",
      "expires: 2026-13-01",
      "---",
      "",
    ].join("\n"),
  );
  assert.equal(broken.name, "A");
  assert.equal(broken.category, "project");
  assert.equal(broken.type, "fact");
  assert.equal(broken.confirmed, false);
  assert.equal(broken.lastConfirmed, undefined);
  assert.equal(broken.expires, undefined);

  const full = parseWorkspaceMemoryFrontmatter(
    [
      "---",
      "name: A",
      "category: UI",
      "type: constraint",
      "source: user",
      "confirmed: true",
      "lastConfirmed: 2026-02-14",
      "expires: 2026-06-01",
      "---",
      "",
    ].join("\n"),
  );
  assert.equal(full.category, "ui");
  assert.equal(full.type, "constraint");
  assert.equal(full.source, "user");
  assert.equal(full.confirmed, true);
  assert.equal(full.lastConfirmed, "2026-02-14");
  assert.equal(full.expires, "2026-06-01");
});

test("expiry prefers expires, then max(lastConfirmed, mtime)", () => {
  const now = Date.UTC(2026, 5, 1);
  const day = 24 * 60 * 60 * 1000;

  // 昨天确认过、mtime 是 120 天前：取较新值，不过期。
  assert.equal(
    resolveWorkspaceMemoryExpiry({
      content: "---\nname: A\nlastConfirmed: 2026-05-31\n---\n",
      mtimeMs: now - 120 * day,
      now,
      expiryDays: 90,
    }).expired,
    false,
  );

  // 没有任何日期线索、mtime 早于阈值：过期。
  const idle = resolveWorkspaceMemoryExpiry({
    content: "---\nname: A\n---\n",
    mtimeMs: now - 100 * day,
    now,
    expiryDays: 90,
  });
  assert.equal(idle.expired, true);
  assert.equal(idle.reason, "idle");

  // expires 已过：即使昨天刚确认也过期。
  const explicit = resolveWorkspaceMemoryExpiry({
    content: "---\nname: A\nlastConfirmed: 2026-05-31\nexpires: 2026-05-20\n---\n",
    mtimeMs: now - day,
    now,
    expiryDays: 90,
  });
  assert.equal(explicit.expired, true);
  assert.equal(explicit.reason, "expires");

  // 关闭闲置规则后只剩 expires 生效。
  assert.equal(
    resolveWorkspaceMemoryExpiry({
      content: "---\nname: A\n---\n",
      mtimeMs: now - 100 * day,
      now,
      expiryDays: 0,
    }).expired,
    false,
  );
});

test("pruning moves expired items out of memory and index", async () => {
  await withRoot(async (root) => {
    const now = Date.UTC(2026, 5, 1);
    const day = 24 * 60 * 60 * 1000;
    await writeFile(join(root, "stale.md"), "---\nname: Stale\ndescription: old\n---\nbody\n");
    await writeFile(join(root, "fresh.md"), "---\nname: Fresh\nlastConfirmed: 2026-05-31\n---\n");
    const old = new Date(now - 200 * day);
    await utimes(join(root, "stale.md"), old, old);
    await writeFile(
      join(root, "MEMORY.md"),
      "- [Stale](stale.md) — old\n- [Fresh](fresh.md) — new\n",
    );

    const { removed } = await pruneExpiredWorkspaceMemories(root, { now, expiryDays: 90 });
    assert.deepEqual(removed, ["stale.md"]);
    await assert.rejects(readFile(join(root, "stale.md"), "utf-8"));
    assert.match(
      await readFile(join(root, WORKSPACE_MEMORY_EXPIRED_DIR_NAME, "stale.md"), "utf-8"),
      /name: Stale/,
    );
    assert.doesNotMatch(await readFile(join(root, "MEMORY.md"), "utf-8"), /stale\.md/);
    assert.match(await readFile(join(root, "MEMORY.md"), "utf-8"), /fresh\.md/);
  });
});

test("extraction prompt states the frontmatter contract and what not to write", () => {
  const prompt = buildWorkspaceMemoryExtractionPrompt({
    transcript: "User: use Node 24\n",
    index: null,
    manifest: [],
  });
  for (const field of ["category", "type", "source", "confirmed", "lastConfirmed"]) {
    assert.match(prompt, new RegExp(`- ${field}:`));
  }
  assert.match(prompt, /transient task state/);
  assert.match(prompt, /project \| todo \| extension \| ui \| protocol/);
  assert.match(prompt, /preference \| constraint \| decision \| fact/);
});

test("manifest carries the category for existing memories", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "ui-theme.md"), "---\nname: Theme\ncategory: ui\n---\nbody\n");
    const manifest = await readWorkspaceMemoryManifest(root);
    assert.equal(manifest[0]?.category, "ui");
    const prompt = buildWorkspaceMemoryExtractionPrompt({
      transcript: "User: hi\n",
      index: null,
      manifest,
    });
    assert.match(prompt, /### ui-theme\.md \(\d+ bytes, ui, updated/);
  });
});
