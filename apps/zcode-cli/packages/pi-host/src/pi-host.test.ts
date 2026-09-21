import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandBridge } from "./command-bridge.js";
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
    result: { tokensBefore: 10, estimatedTokensAfter: 2 },
  });
  projector.apply({ type: "agent_settled" });
  const kinds = projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.deepEqual(kinds, ["turnHeader", "userInput", "assistantText", "toolCall", "timelineMarker"]);
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.toolName : "", "Read");
  const header = projector.getSnapshot().rows.window[0];
  assert.equal(header && header.kind === "turnHeader" ? header.state : "", "completedInterrupted");
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
  parent.projector.apply({ type: "agent_settled" });
  const assistant = parent.projector.getSnapshot().rows.window.find((row) => row.kind === "assistantText");
  assert.equal(assistant && assistant.kind === "assistantText" ? assistant.actions?.canFork : false, true);
  parent.projector.setFeedback(assistant?.entityId ?? "", "like");
  const liked = parent.projector.getSnapshot().rows.window.find((row) => row.kind === "assistantText");
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
