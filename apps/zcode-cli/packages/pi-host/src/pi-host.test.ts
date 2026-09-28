import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CommandBridge, sendDelivery } from "./command-bridge.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { FakePiSession } from "./fake-session.js";
import { HostQueue } from "./host-queue.js";
import { PluginViewRegistry } from "./plugin-adapters/registry.js";
import { mapPiToolName } from "./presentation.js";
import { PiToV4Projector } from "./projector.js";
import { gateTool } from "./permission-gate.js";
import { HostSessionRegistry } from "./session-registry.js";

test("maps builtin pi tool names", () => {
  assert.equal(mapPiToolName("read"), "Read");
  assert.equal(mapPiToolName("bash"), "Bash");
  assert.equal(mapPiToolName("powershell"), "Bash");
  assert.equal(mapPiToolName("edit"), "Edit");
  assert.equal(mapPiToolName("write"), "Write");
  assert.equal(mapPiToolName("grep"), "Grep");
  assert.equal(mapPiToolName("find"), "Glob");
  assert.equal(mapPiToolName("weird_ext"), "weird_ext");
  assert.equal(mapPiToolName("agent", true), "Agent");
  assert.equal(mapPiToolName("agent", false), "agent");
  assert.equal(mapPiToolName(undefined), "Tool");
});

test("first user message names the session and reload replaces rows", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_start",
    message: { role: "user", content: "文件夹下有什么", id: "u1" },
  });
  assert.equal(projector.getSnapshot().meta.title, "文件夹下有什么");
  projector.reload([
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: "kept", id: "u2" } },
  ]);
  const texts = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput")
    .map((row) => (row.kind === "userInput" ? row.text : ""));
  assert.deepEqual(texts, ["kept"]);
});

test("toolcall_start without a name does not throw", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1" },
  });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "c1", name: "bash", arguments: { command: "echo hi" } },
    },
  });
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.toolName : "", "Bash");
});

test("context usage is a ring input and ignores an unchanged value", () => {
  const projector = new PiToV4Projector("s1", "e1");
  const first = projector.setContextUsage(1200, 8000);
  assert.equal(projector.getSnapshot().usage.contextWindow?.usedTokens, 1200);
  assert.equal(projector.getSnapshot().usage.contextWindow?.maxTokens, 8000);
  assert.equal(first.length > 0, true);
  assert.equal(projector.setContextUsage(1200, 8000).length, 0);
});

test("projects text, tools, abort, compact", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_start",
    message: { role: "user", content: "hi" },
  });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
  });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "read" },
  });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "read",
    args: { path: "a.ts" },
  });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "read",
    result: { content: [{ text: "file" }] },
  });
  projector.markAborted();
  projector.apply({ type: "compaction_start" });
  projector.apply({
    type: "compaction_end",
    result: { summary: "kept the greeting", tokensBefore: 10, estimatedTokensAfter: 2 },
  });
  projector.apply({ type: "agent_settled" });
  const kinds = projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.deepEqual(kinds, ["turnHeader", "userInput", "assistantText", "toolCall", "timelineMarker"]);
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.toolName : "", "Read");
  const header = projector.getSnapshot().rows.window[0];
  assert.equal(header && header.kind === "turnHeader" ? header.state : "", "completedInterrupted");
  const compact = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    compact && compact.kind === "timelineMarker" && compact.marker.type === "compact"
      ? compact.marker.summary
      : "",
    "kept the greeting",
  );
});

test("compact failure keeps the Pi reason on the marker and the composer banner", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "compaction_start" });
  projector.apply({
    type: "compaction_end",
    errorMessage: "Compaction failed: Nothing to compact (session too small)",
  });
  const compact = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    compact && compact.kind === "timelineMarker" && compact.marker.type === "compact"
      ? compact.marker.status
      : "",
    "failed",
  );
  assert.equal(
    compact && compact.kind === "timelineMarker" && compact.marker.type === "compact"
      ? compact.marker.error
      : "",
    "Nothing to compact (session too small)",
  );
  assert.equal(projector.getSnapshot().control.lastError?.code, "fault.compact");
  assert.match(
    projector.getSnapshot().control.lastError?.message ?? "",
    /Nothing to compact/,
  );
});

test("retry keeps one working turn and shows the final error", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_start",
    message: { role: "user", content: "hi", id: "u1" },
  });
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "anthropic 404" },
  });
  projector.apply({ type: "agent_end", willRetry: true });
  projector.apply({ type: "agent_start" });
  const mid = projector.getSnapshot();
  assert.equal(mid.rows.window.filter((row) => row.kind === "turnHeader").length, 1);
  assert.equal(mid.control.phase, "running");
  assert.equal(
    mid.rows.window.some((row) => row.kind === "assistantText"),
    false,
  );
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "still anthropic" },
  });
  projector.apply({ type: "agent_end" });
  const done = projector.getSnapshot();
  assert.equal(done.rows.window.filter((row) => row.kind === "turnHeader").length, 1);
  assert.equal(done.control.phase, "completedSuccess");
  assert.equal(
    done.rows.window.some((row) => row.kind === "assistantText"),
    false,
  );
  assert.equal(done.control.lastError?.message, "still anthropic");
  assert.equal(done.control.apiRetry, null);
  projector.apply({ type: "agent_settled" });
  assert.equal(projector.getSnapshot().control.lastError?.message, "still anthropic");
});

test("retry shows a count and the final error stays one sentence", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  const raw =
    '503 {"type":"error","error":{"type":"api_error","message":"Gateway routing failed","request_id":"abc"}}';
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: raw },
  });
  projector.apply({ type: "agent_end", willRetry: true });
  projector.apply({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: raw,
  });
  const mid = projector.getSnapshot();
  assert.equal(mid.control.phase, "running");
  assert.equal(mid.rows.window.filter((row) => row.kind === "turnHeader").length, 1);
  assert.equal(mid.control.apiRetry?.attempt, 1);
  assert.equal(mid.control.apiRetry?.maxAttempts, 4);
  assert.equal(mid.control.apiRetry?.failures?.[0]?.message, "503 Gateway routing failed");
  assert.equal(mid.rows.window.some((row) => row.kind === "assistantText"), false);
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: raw },
  });
  projector.apply({ type: "agent_end" });
  const done = projector.getSnapshot();
  assert.equal(done.rows.window.some((row) => row.kind === "assistantText"), false);
  assert.equal(done.control.lastError?.message, "503 Gateway routing failed");
  assert.match(done.control.lastError?.detail ?? "", /1\. 503 Gateway routing failed/);
  assert.match(done.control.lastError?.detail ?? "", /Gateway routing failed","request_id"/);
  assert.equal(done.control.apiRetry, null);
});

test("stop during retry stays aborted when the next attempt starts", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "agent_end", willRetry: true });
  projector.apply({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: "Connection error.",
  });
  projector.markAborted();
  projector.apply({ type: "agent_start" });
  assert.equal(projector.wantsStop(), true);
  assert.equal(projector.getSnapshot().control.phase, "running");
  projector.apply({ type: "agent_end" });
  projector.apply({ type: "agent_settled" });
  const done = projector.getSnapshot();
  assert.equal(done.control.phase, "completedInterrupted");
  assert.equal(done.control.canStop, false);
  assert.equal(projector.wantsStop(), false);
});

test("message_end + agent_end flushes assistant text", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "n" },
        { type: "text", text: "pong" },
      ],
    },
  });
  projector.apply({ type: "agent_end" });
  const snap = projector.getSnapshot();
  const text = snap.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(text && text.kind === "assistantText" ? text.text : "", "pong");
  assert.equal(snap.control.phase, "completedSuccess");
});

test("replayable streams tool progress not inputText", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "replayable" });
  projector.apply({ type: "agent_start" });
  const deltas = [
    ...projector.apply({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
    }),
    ...projector.apply({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y" },
    }),
    ...projector.apply({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" },
    }),
    ...projector.apply({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"c\":1}" },
    }),
    ...projector.apply({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
    }),
    ...projector.apply({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      partialResult: { content: [{ text: "out" }] },
    }),
  ];
  assert.equal(
    deltas.some((delta) => delta.op === "row.delta" && delta.path === "inputText"),
    false,
  );
  assert.equal(
    deltas.some((delta) => delta.op === "row.delta" && delta.path === "text"),
    true,
  );
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.ok(tool && tool.kind === "toolCall" && tool.progress);
});

test("submission model is applied when the prompt starts, not while queued", async () => {
  const session = new FakePiSession("s");
  const queue = new HostQueue();
  const applied: string[] = [];
  const bridge = new CommandBridge(session, queue, async (selection) => {
    applied.push(`${selection.providerId}/${selection.modelId}`);
  });
  await bridge.admitSend({
    text: "now",
    clientId: "c",
    commandId: "1",
    delivery: "startNow",
    streaming: false,
    modelSelection: { providerId: "lens", modelId: "next" },
  });
  assert.deepEqual(applied, ["lens/next"]);
  session.isStreaming = true;
  await bridge.admitSend({
    text: "later",
    clientId: "c",
    commandId: "2",
    delivery: "queue",
    streaming: true,
    modelSelection: { providerId: "lens", modelId: "queued", thought: "high" },
  });
  assert.deepEqual(applied, ["lens/next"]);
  session.isStreaming = false;
  assert.equal(await bridge.drainNext(), true);
  assert.deepEqual(applied, ["lens/next", "lens/queued"]);
  assert.deepEqual(session.prompts, ["now", "later"]);
});

test("image attachments are sent as bytes and shown on the user row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-image-"));
  const file = join(dir, "dot.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(file, png);
  try {
    const session = new FakePiSession("s");
    const queue = new HostQueue();
    const noted: string[][] = [];
    const bridge = new CommandBridge(session, queue, undefined, (refs) => {
      noted.push(refs.map((item) => item.ref));
    });
    const attachment = {
      type: "image" as const,
      path: file,
      filename: "dot.png",
      mimeType: "image/png",
      sizeBytes: png.length,
    };
    await bridge.admitSend({
      text: "see this",
      clientId: "c",
      commandId: "1",
      delivery: "startNow",
      streaming: false,
      attachments: [attachment],
    });
    assert.equal(session.promptImages[0]?.[0]?.data, png.toString("base64"));
    session.isStreaming = true;
    await bridge.admitSend({
      text: "later",
      clientId: "c",
      commandId: "2",
      delivery: "queue",
      streaming: true,
      attachments: [attachment],
    });
    session.isStreaming = false;
    assert.equal(await bridge.drainNext(), true);
    assert.equal(session.promptImages[1]?.[0]?.mimeType, "image/png");
    assert.deepEqual(noted, [[file], [file]]);
    const projector = new PiToV4Projector("s", "e1");
    projector.noteUserAttachments([
      { ref: file, fileName: "dot.png", mime: "image/png", bytes: png.length },
    ]);
    projector.apply({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "see this" }], id: "u1" },
    });
    const row = projector.getSnapshot().rows.window.find((item) => item.kind === "userInput");
    assert.equal(row?.kind, "userInput");
    if (row?.kind === "userInput") assert.equal(row.attachments?.[0]?.ref, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("busy or compacting sends join the queue instead of prompting", () => {
  assert.equal(sendDelivery({ guide: false, phaseRunning: false, idle: true }), "startNow");
  assert.equal(sendDelivery({ guide: false, phaseRunning: true, idle: false }), "queue");
  assert.equal(sendDelivery({ guide: true, phaseRunning: true, idle: false }), "guide");
  assert.equal(sendDelivery({ guide: true, phaseRunning: false, idle: false }), "queue");
});

test("queued text is sent after compaction finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  try {
    const hosted = await registry.create({ workspacePath: root });
    const fake = fakes.get(hosted.sessionId);
    assert.ok(fake);
    await hosted.bridge.admitSend({
      text: "later",
      clientId: "c",
      commandId: "q1",
      delivery: "queue",
      streaming: false,
    });
    assert.deepEqual(fake.prompts, []);
    fake.isStreaming = true;
    fake.emit({ type: "compaction_end" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.prompts, []);
    fake.isStreaming = false;
    fake.emit({ type: "compaction_end", result: { summary: "ok" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.prompts, ["later"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox routes prompt/steer/queue without pi queue_update", async () => {
  const session = new FakePiSession("s");
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue);
  session.isStreaming = false;
  const idle = await bridge.admitSend({
    text: "a",
    clientId: "c",
    commandId: "1",
    delivery: "startNow",
    streaming: false,
  });
  assert.equal(idle.kind, "prompt");
  session.isStreaming = true;
  const guided = await bridge.admitSend({
    text: "b",
    clientId: "c",
    commandId: "2",
    delivery: "guide",
    streaming: true,
  });
  assert.equal(guided.kind, "steer");
  const queued = await bridge.admitSend({
    text: "c",
    clientId: "c",
    commandId: "3",
    delivery: "queue",
    streaming: true,
  });
  assert.equal(queued.kind, "queued");
  assert.equal(session.followUps.length, 0);
  assert.equal(queue.snapshot().items.length, 1);
  await bridge.stop();
  await bridge.compact();
  assert.equal(session.aborted, true);
  assert.equal(session.compacted, true);
});

test("extension ui request/response and empty custom registry", async () => {
  const ui = new ExtensionUiHost(new PluginViewRegistry());
  const select = ui.handle({
    type: "extension_ui_request",
    id: "q1",
    method: "select",
    title: "Pick",
    options: ["A", "B"],
  });
  assert.equal(select.pending.length, 1);
  const selectPayload = select.pending[0]?.payload;
  assert.equal(selectPayload?.kind, "userInput");
  if (selectPayload?.kind === "userInput") {
    assert.equal(selectPayload.questions?.[0]?.options[0]?.value, "A");
    assert.equal(selectPayload.questions?.[0]?.options[1]?.label, "B");
  }
  const waiting = ui.wait("q1");
  assert.equal(ui.respond({ id: "q1", value: "A" }), true);
  assert.equal((await waiting).id, "q1");
  const confirm = ui.handle({
    type: "extension_ui_request",
    id: "q2",
    method: "confirm",
    title: "Go?",
  });
  assert.equal(confirm.pending[0]?.payload.kind, "userInput");
  const confirmWait = ui.wait("q2");
  assert.equal(ui.respond({ id: "q2", confirmed: true }), true);
  assert.equal((await confirmWait).id, "q2");
  const custom = ui.handle({
    type: "extension_ui_request",
    id: "c1",
    method: "custom",
    pluginId: "unknown",
  });
  assert.equal(custom.widgets[0]?.lines[0], "(unsupported plugin view)");
});

test("full access skips confirms but still shows questions", async () => {
  const ui = new ExtensionUiHost();
  ui.autoConfirm = true;
  const select = ui.handle({
    type: "extension_ui_request",
    id: "q1",
    method: "select",
    title: "Pick",
    options: ["A", "B"],
  });
  assert.equal(select.pending.length, 1);
  const confirmWait = ui.wait("q2");
  const confirm = ui.handle({
    type: "extension_ui_request",
    id: "q2",
    method: "confirm",
    title: "Go?",
  });
  assert.equal(confirm.pending.length, 1);
  assert.equal(confirm.pending[0]?.interactionId, "q1");
  assert.deepEqual(await confirmWait, { id: "q2", confirmed: true });
});

test("tool permission ask projects PermissionDialog payload", async () => {
  const ui = new ExtensionUiHost();
  const waiting = ui.wait("perm:1");
  const next = ui.askPermission({
    id: "perm:1",
    toolName: "Bash",
    summary: "Tool has side effects and requires approval",
    detail: { command: "Start-Sleep -Seconds 1" },
  });
  assert.equal(next.pending[0]?.kind, "permission");
  assert.equal(next.pending[0]?.payload.kind, "permission");
  if (next.pending[0]?.payload.kind !== "permission") throw new Error("expected permission");
  assert.equal(next.pending[0].payload.toolName, "Bash");
  assert.deepEqual(
    next.pending[0].payload.options.map((option) => option.optionId),
    ["allowOnce", "allowAlways", "deny"],
  );
  assert.equal(ui.respond({ id: "perm:1", value: "allowAlways" }), true);
  assert.equal((await waiting).id, "perm:1");
});

test("gateTool denies", async () => {
  await assert.rejects(
    () => gateTool(async () => "deny", "bash", {}),
    /permission denied/,
  );
  await gateTool(async () => "allow", "read", {});
});

test("navigateTree truncates and fork copies jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const parent = await registry.create({ workspacePath: root });
  parent.projector.apply({ type: "agent_start" });
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u1", content: "hi" },
  });
  parent.projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a1" },
  });
  parent.projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "yo" },
  });
  parent.projector.apply({ type: "agent_end" });
  parent.projector.apply({ type: "agent_start" });
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u2", content: "later" },
  });
  parent.projector.apply({
    type: "message_start",
    message: { role: "assistant", id: "a2" },
  });
  parent.projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "again" },
  });
  parent.projector.apply({ type: "agent_settled" });
  const assistants = parent.projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "assistantText");
  assert.equal(assistants.length, 2);
  assert.equal(
    assistants.every((row) => row.kind === "assistantText" && row.actions?.canFork === true),
    true,
  );
  assert.equal(
    assistants[0] && assistants[0].kind === "assistantText"
      ? assistants[0].actions?.canRetry === true
      : true,
    false,
  );
  const assistant = assistants[1];
  assert.equal(assistant && assistant.kind === "assistantText" ? assistant.actions?.canRetry : false, true);
  parent.projector.setFeedback(assistant?.entityId ?? "", "like");
  const liked = parent.projector.getSnapshot().rows.window.find((row) => row.entityId === assistant?.entityId);
  assert.equal(liked && liked.kind === "assistantText" ? liked.feedback : undefined, "like");
  const child = await registry.fork(parent.sessionId, "a1");
  assert.ok(child.sessionId !== parent.sessionId);
  await parent.navigateTree("u1");
  assert.equal(
    parent.projector.getSnapshot().rows.window.some((row) => row.kind === "userInput"),
    false,
  );
  await rm(root, { recursive: true, force: true });
});

test("registry spawn has workId; bypass does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  const parent = await registry.create({ workspacePath: root });
  const child = await registry.spawn(parent.sessionId);
  assert.ok(child.workId);
  assert.equal(child.viaRegistry, true);
  const bypass = new FakePiSession("raw");
  assert.equal("workId" in bypass, false);
  await rm(root, { recursive: true, force: true });
});

test("list skips empty jsonl and hydrateHistory rebuilds rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const empty = await registry.create({ workspacePath: root, sessionId: "sess_empty" });
  assert.equal(empty.sessionFile.startsWith(join(root, "pi-sessions")), true);
  const dir = join(root, "pi-host-sessions", Buffer.from(root).toString("base64url"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "2026-01-02T03-04-05_01fork.jsonl"),
    [
      '{"type":"session","id":"01fork","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"forked"}]}}',
    ].join("\n"),
  );
  await writeFile(
    join(dir, "sess_chat.jsonl"),
    [
      '{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"hello pi"}]}}',
      '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ].join("\n"),
  );
  const listed = await registry.list(root);
  assert.equal(listed.some((item) => item.sessionId === empty.sessionId), false);
  assert.equal(listed.map((item) => item.sessionId).join(","), "01fork,sess_chat");
  assert.equal(listed.find((item) => item.sessionId === "sess_chat")?.title, "hello pi");
  const found = await registry.find("sess_chat");
  assert.equal(found?.sessionId, "sess_chat");
  const opened = await registry.create({ workspacePath: root, sessionId: "sess_chat" });
  const kinds = opened.projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.ok(kinds.includes("userInput"));
  assert.ok(kinds.includes("assistantText"));
  await rm(root, { recursive: true, force: true });
});

test("list and resume native Pi jsonl by header id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const nativeRoot = join(root, "pi-sessions");
  const cwd = join(root, "proj");
  await mkdir(cwd, { recursive: true });
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: nativeRoot,
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const resolved = resolve(cwd);
  const safePath = `--${resolved.replace(/^[\\/]/u, "").replace(/[\\/:]/gu, "-")}--`;
  const dir = join(nativeRoot, safePath);
  await mkdir(dir, { recursive: true });
  const sessionFile = join(dir, "2026-01-02T03-04-05_01native.jsonl");
  await writeFile(
    sessionFile,
    [
      `{"type":"session","id":"01native","timestamp":"2026-01-02T03:04:05.000Z","cwd":${JSON.stringify(cwd)}}`,
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"from pi tui"}]}}',
    ].join("\n"),
  );
  const listed = await registry.list(cwd);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.sessionId, "01native");
  assert.equal(listed[0]?.title, "from pi tui");
  const found = await registry.find("01native");
  assert.equal(found?.sessionFile, sessionFile);
  const opened = await registry.create({ workspacePath: cwd, sessionId: "01native" });
  assert.equal(opened.sessionFile, sessionFile);
  await rm(root, { recursive: true, force: true });
});

test("ssh sessions stay under the remote identity and still list the old drive-letter dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const nativeRoot = join(root, "pi-sessions");
  const identity = "remote:ssh:example:22:root:/root/proxy-sticky";
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: nativeRoot,
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const created = await registry.create({
    workspaceIdentity: identity,
    workspacePath: "/root/proxy-sticky",
    sessionId: "sess_ssh",
  });
  assert.match(created.sessionFile, /remote-ssh-example-22-root--root-proxy-sticky/);
  await writeFile(
    created.sessionFile,
    [
      '{"type":"session","id":"sess_ssh","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/root/proxy-sticky"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"remote hi"}]}}',
    ].join("\n"),
  );
  const resolved = resolve("/root/proxy-sticky");
  const legacyDir = join(
    nativeRoot,
    `--${resolved.replace(/^[\\/]/u, "").replace(/[\\/:]/gu, "-")}--`,
  );
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    join(legacyDir, "2026-01-02T03-04-05_sess_old.jsonl"),
    [
      `{"type":"session","id":"sess_old","timestamp":"2026-01-02T03:04:05.000Z","cwd":${JSON.stringify(resolved)}}`,
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"old remote"}]}}',
    ].join("\n"),
  );
  const listed = await registry.list(identity);
  assert.deepEqual(
    listed.map((item) => item.sessionId).sort(),
    ["sess_old", "sess_ssh"],
  );
  await rm(root, { recursive: true, force: true });
});

test("delete removes a cold fork file and a live session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const dir = join(root, "pi-host-sessions", Buffer.from(root).toString("base64url"));
  await mkdir(dir, { recursive: true });
  const forkFile = join(dir, "2026-01-02T03-04-05_01fork.jsonl");
  await writeFile(
    forkFile,
    [
      '{"type":"session","id":"01fork","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"forked"}]}}',
    ].join("\n"),
  );
  const live = await registry.create({ workspacePath: root, sessionId: "sess_live" });
  await writeFile(
    live.sessionFile,
    [
      '{"type":"session","id":"sess_live","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"live"}]}}',
    ].join("\n"),
  );
  assert.equal(await registry.delete("01fork", root), true);
  assert.equal(await registry.delete("sess_live", root), true);
  await assert.rejects(access(forkFile));
  await assert.rejects(access(live.sessionFile));
  assert.equal(registry.get("sess_live"), undefined);
  await rm(root, { recursive: true, force: true });
});
