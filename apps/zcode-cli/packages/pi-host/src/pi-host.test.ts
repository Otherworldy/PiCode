import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { conversationDeltaSchema } from "@zcode/shared/zcode-protocol-v4";
import { CommandBridge, sendDelivery } from "./command-bridge.js";
import { createHostExtensionUi } from "./extension-ui-bridge.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { FakePiSession } from "./fake-session.js";
import { HostQueue } from "./host-queue.js";
import { PluginViewRegistry } from "./plugin-adapters/registry.js";
import { mapPiToolName } from "./presentation.js";
import { PiToV4Projector } from "./projector.js";
import { isPlannotatorReviewDismissed, takePlanDecision } from "./plan-review-signal.js";
import { gateTool } from "./permission-gate.js";
import { HostSessionRegistry } from "./session-registry.js";
import { contextUsagePublish } from "./types.js";

test("finished ask_user_question clears the waiting interaction", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start" });
  projector.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "ask_user_question",
    args: {},
  });
  projector.replaceInteractions([
    {
      interactionId: "q1",
      kind: "userInput",
      anchorRowId: null,
      createdAt: 1,
      payload: {
        kind: "userInput",
        prompt: "哪一种？",
        freeText: false,
        questions: [
          {
            question: "哪一种？",
            header: "Ask",
            options: [{ value: "A", label: "A" }],
          },
        ],
      },
    },
  ]);
  assert.equal(projector.getSnapshot().pendingInteractions.length, 1);
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "ask_user_question",
    result: { content: [{ text: "User has answered your questions: \"哪一种？\"=\"A\"" }] },
  });
  assert.equal(projector.getSnapshot().pendingInteractions.length, 0);
  const row = projector.getSnapshot().rows.window.find((item) => item.kind === "toolCall");
  assert.equal(row?.kind === "toolCall" ? row.status : "", "success");
});

test("replaying an old ask does not clear a live question", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.replaceInteractions([
    {
      interactionId: "live",
      kind: "userInput",
      anchorRowId: null,
      createdAt: 1,
      payload: {
        kind: "userInput",
        prompt: "还在问",
        freeText: false,
        toolName: "AskUserQuestion",
        questions: [
          { question: "还在问", header: "Ask", options: [{ value: "A", label: "A" }] },
        ],
      },
    },
  ]);
  projector.replay([
    {
      type: "tool_execution_start",
      toolCallId: "old",
      toolName: "ask_user_question",
      args: {},
    },
    {
      type: "tool_execution_end",
      toolCallId: "old",
      toolName: "ask_user_question",
      result: { content: [{ text: "done" }] },
    },
  ]);
  assert.equal(projector.getSnapshot().pendingInteractions[0]?.interactionId, "live");
});

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

test("a bare slash command does not name the session", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({
    type: "message_start",
    message: { role: "user", content: "/plannotator-plan-mode", id: "u0" },
  });
  assert.equal(projector.getSnapshot().meta.title, "");
  projector.apply({
    type: "message_start",
    message: { role: "user", content: "修登录", id: "u1" },
  });
  assert.equal(projector.getSnapshot().meta.title, "修登录");
  assert.equal(projector.setTitle("/plannotator-plan-mode", "generated").length, 0);
  assert.equal(projector.getSnapshot().meta.title, "修登录");
  projector.setTitle("手改标题", "custom");
  assert.equal(projector.setTitle("自动标题", "generated").length, 0);
  assert.equal(projector.getSnapshot().meta.title, "手改标题");
  assert.equal(projector.getSnapshot().meta.titleSource, "custom");
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

test("context usage publishes while the turn is still running", () => {
  assert.equal(
    contextUsagePublish({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" },
    }),
    "soon",
  );
  assert.equal(contextUsagePublish({ type: "message_end", message: { role: "assistant" } }), "now");
  assert.equal(
    contextUsagePublish({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" }),
    "now",
  );
  assert.equal(contextUsagePublish({ type: "compaction_end" }), "now");
  assert.equal(contextUsagePublish({ type: "agent_end" }), "now");
  assert.equal(contextUsagePublish({ type: "agent_end", willRetry: true }), "no");
  assert.equal(contextUsagePublish({ type: "agent_start" }), "no");
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
  assert.deepEqual(kinds, [
    "turnHeader",
    "userInput",
    "assistantText",
    "toolCall",
    "timelineMarker",
  ]);
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

test("idle compaction can be stopped and then clears the stop control", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "compaction_start" });
  assert.equal(projector.getSnapshot().control.canStop, true);
  assert.equal(projector.getSnapshot().control.stopTargetKind, "compact");
  const running = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    running && running.kind === "timelineMarker" ? running.lane : "",
    "turnTailBoundary",
  );
  projector.apply({ type: "compaction_end", aborted: true });
  assert.equal(projector.getSnapshot().control.canStop, false);
  assert.equal(projector.getSnapshot().control.stopTargetKind, "unknown");
  const compact = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    compact && compact.kind === "timelineMarker" && compact.marker.type === "compact"
      ? compact.marker.status
      : "",
    "cancelled",
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
  assert.match(projector.getSnapshot().control.lastError?.message ?? "", /Nothing to compact/);
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
  assert.equal(done.control.phase, "error");
  const failedHeader = done.rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(failedHeader && failedHeader.kind === "turnHeader" ? failedHeader.state : "", "failed");
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
  assert.equal(
    mid.rows.window.some((row) => row.kind === "assistantText"),
    false,
  );
  projector.apply({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: raw },
  });
  projector.apply({ type: "agent_end" });
  const done = projector.getSnapshot();
  assert.equal(
    done.rows.window.some((row) => row.kind === "assistantText"),
    false,
  );
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

test("open plan review stays working until the decision or plan mode ends", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start", at: 1_000 });
  projector.apply({
    type: "tool_execution_start",
    at: 1_100,
    toolCallId: "c1",
    toolName: "plannotator_submit_plan",
    args: { filePath: "PLAN.md" },
  });
  projector.apply({
    type: "tool_execution_end",
    at: 1_500,
    toolCallId: "c1",
    toolName: "plannotator_submit_plan",
    result: { details: { pending: true, approved: false } },
  });
  projector.apply({ type: "agent_end", at: 1_600 });
  const waiting = projector.getSnapshot();
  const waitingHeader = waiting.rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(waitingHeader && waitingHeader.kind === "turnHeader" ? waitingHeader.state : "", "running");
  assert.equal(
    waitingHeader && waitingHeader.kind === "turnHeader" ? waitingHeader.endedAt : 0,
    undefined,
  );
  assert.equal(waiting.control.phase, "completedSuccess");
  assert.equal(waiting.control.canStop, true);

  projector.replaceStatuses([{ key: "plannotator", text: "plan" }]);
  const stillPlanning = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(stillPlanning && stillPlanning.kind === "turnHeader" ? stillPlanning.state : "", "running");

  projector.apply({ type: "agent_start", at: 3_000 });
  projector.apply({
    type: "tool_execution_end",
    at: 3_200,
    toolCallId: "c2",
    toolName: "plannotator_submit_plan",
    result: { details: { pending: true, revised: true } },
  });
  const revised = projector.getSnapshot().rows.window.filter((row) => row.kind === "turnHeader");
  assert.equal(revised[0] && revised[0].kind === "turnHeader" ? revised[0].state : "", "completedSuccess");
  projector.apply({ type: "agent_end", at: 3_300 });
  const stillOpen = projector.getSnapshot().rows.window.filter((row) => row.kind === "turnHeader");
  assert.equal(stillOpen[1] && stillOpen[1].kind === "turnHeader" ? stillOpen[1].state : "", "running");
  assert.equal(projector.getSnapshot().control.phase, "completedSuccess");

  projector.finishOpenPlanReview(4_000);
  const decided = projector.getSnapshot().rows.window.filter((row) => row.kind === "turnHeader");
  assert.equal(decided[1] && decided[1].kind === "turnHeader" ? decided[1].state : "", "completedSuccess");
  assert.equal(decided[1] && decided[1].kind === "turnHeader" ? decided[1].activeMs : 0, 1_000);
});

test("leaving plan mode ends the working plan review", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start", at: 1_000 });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "plannotator_submit_plan",
    result: { details: { pending: true } },
  });
  projector.apply({ type: "agent_end" });
  projector.replaceStatuses([]);
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(header && header.kind === "turnHeader" ? header.state : "", "completedSuccess");
});

test("a stopped plan submit does not stay working", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start", at: 1_000 });
  projector.apply({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "plannotator_submit_plan",
    result: { details: { pending: true } },
  });
  projector.markAborted();
  projector.apply({ type: "agent_end" });
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(
    header && header.kind === "turnHeader" ? header.state : "",
    "completedInterrupted",
  );
});

test("plan decisions match extension text and ignore the user's own messages", () => {
  const pending = ["Plan approved. Execute it."];
  assert.equal(takePlanDecision(pending, "继续改一下范围"), false);
  assert.deepEqual(pending, ["Plan approved. Execute it."]);
  assert.equal(takePlanDecision(pending, "Plan approved. Execute it."), true);
  assert.deepEqual(pending, []);
});

test("plannotator feedback stays a user message", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start", at: 1_000 });
  const feedback =
    "Plannotator: hello world.html (pn-1ef1dc) — Feedback · 1 comment.\n\n# Markdown Annotations";
  projector.apply({
    type: "message_start",
    message: { role: "user", content: feedback, id: "u-review" },
  });
  const users = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput")
    .map((row) => (row.kind === "userInput" ? row.text : ""));
  assert.deepEqual(users, [feedback]);
  assert.equal(isPlannotatorReviewDismissed("Annotation closed (no feedback)."), true);
  assert.equal(isPlannotatorReviewDismissed("Annotation opened"), false);
});

test("PLANNOTATOR_BROWSER=none 时审查页地址从通知进内置浏览器", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    redirectPlannotatorToEmbeddedBrowser: true,
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  const previous = process.env.PLANNOTATOR_BROWSER;
  // 上游 0.28.22 起 none 值不再 spawn 任何浏览器，spawn 拦截拿不到地址。
  process.env.PLANNOTATOR_BROWSER = "none";
  try {
    const hosted = await registry.create({ workspacePath: root });
    const fake = fakes.get(hosted.sessionId);
    assert.ok(fake);
    const opened: string[] = [];
    const unsubscribe = hosted.onDeltas((deltas) => {
      for (const delta of deltas) {
        if (delta.op === "embeddedBrowser.open") opened.push(delta.url);
      }
    });
    const notify = (message: string) => {
      fake.emit({
        type: "extension_ui_request",
        id: "n1",
        method: "notify",
        message,
        notifyType: "info",
      });
    };
    const reviewUrl = "http://127.0.0.1:5300/plan-review/abc";
    notify(
      `Plannotator: plan review opened at ${reviewUrl}. Not opening a browser (PLANNOTATOR_BROWSER=none). You can keep chatting while it runs.`,
    );
    assert.deepEqual(opened, [reviewUrl]);
    // 同一个地址再来一条通知不开第二个页。
    notify(`Plannotator session ready: ${reviewUrl}`);
    assert.deepEqual(opened, [reviewUrl]);
    // 审查页关掉之后，同一个地址（固定端口时）可以再开一次。
    notify("Annotation closed (no feedback).");
    notify(`Plannotator session ready: ${reviewUrl}`);
    assert.deepEqual(opened, [reviewUrl, reviewUrl]);
    unsubscribe();
  } finally {
    if (previous === undefined) delete process.env.PLANNOTATOR_BROWSER;
    else process.env.PLANNOTATOR_BROWSER = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ui design review stays working until the mode ends", () => {
  const projector = new PiToV4Projector("s1", "e1");
  projector.apply({ type: "agent_start", at: 1_000 });
  projector.holdDesignReview();
  projector.apply({ type: "agent_end", at: 1_600 });
  const waiting = projector.getSnapshot();
  const waitingHeader = waiting.rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(waitingHeader && waitingHeader.kind === "turnHeader" ? waitingHeader.state : "", "running");
  assert.equal(waiting.control.phase, "completedSuccess");
  assert.equal(waiting.control.canStop, true);

  projector.replaceStatuses([{ key: "ui-design", text: "UI 设计" }]);
  const stillDesigning = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(
    stillDesigning && stillDesigning.kind === "turnHeader" ? stillDesigning.state : "",
    "running",
  );

  projector.replaceStatuses([]);
  const finished = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(finished && finished.kind === "turnHeader" ? finished.state : "", "completedSuccess");
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
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "c1",
        toolName: "bash",
      },
    }),
    ...projector.apply({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"c":1}' },
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

test("an extension command returns before its dialog is answered", async () => {
  const session = new FakePiSession("s");
  session.slashCommands = [
    {
      name: "web-tools",
      description: "show config",
      inputHint: "/web-tools",
      source: "extension",
    },
  ];
  session.prompt = () => new Promise(() => undefined);
  const bridge = new CommandBridge(session, new HostQueue(), undefined, undefined, {
    uiReady: Promise.resolve(),
    run: async (_command, execute) => {
      await execute();
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    bridge.admitSend({
      text: "/web-tools --show",
      clientId: "c",
      commandId: "1",
      delivery: "startNow",
      streaming: false,
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("extension command waited for its own dialog")), 200);
    }),
  ]);
  if (timer) clearTimeout(timer);
  assert.equal(result.kind, "handled");
});

test("an extension slash command runs while streaming and is not queued", async () => {
  const session = new FakePiSession("s");
  session.isStreaming = true;
  session.acceptPrompt = "handled";
  session.slashCommands = [
    {
      name: "web-tools",
      description: "show config",
      inputHint: "/web-tools",
      source: "extension",
    },
  ];
  const seen: string[] = [];
  const bridge = new CommandBridge(session, new HostQueue(), undefined, undefined, {
    run: async (command, execute) => {
      seen.push(command);
      await execute();
    },
  });
  const result = await bridge.admitSend({
    text: "/Web-Tools --show",
    clientId: "c",
    commandId: "1",
    delivery: "queue",
    streaming: true,
  });
  assert.equal(result.kind, "handled");
  assert.deepEqual(seen, ["web-tools"]);
  for (let i = 0; i < 5 && session.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(session.prompts, ["/web-tools --show"]);
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

test("resized image notes stay out of the user bubble", () => {
  const note =
    "[Image: original 2560x1392, displayed at 2000x1088. Multiply coordinates by 1.28 to map to original image.]";
  const projector = new PiToV4Projector("s", "e1");
  projector.apply({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: `\u6700\u65b0\u7684\u6d88\u606f\u548c\u8f93\u5165\u6846\u592a\u9760\u8fd1\u4e86\n\n${note}` }],
      id: "u1",
    },
  });
  const row = projector.getSnapshot().rows.window.find((item) => item.kind === "userInput");
  assert.equal(row?.kind === "userInput" ? row.text : "", "\u6700\u65b0\u7684\u6d88\u606f\u548c\u8f93\u5165\u6846\u592a\u9760\u8fd1\u4e86");
  assert.equal(projector.getSnapshot().meta.title, "\u6700\u65b0\u7684\u6d88\u606f\u548c\u8f93\u5165\u6846\u592a\u9760\u8fd1\u4e86");

  const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
  projector.apply({
    type: "message_start",
    message: { role: "user", content: `\u770b\u4e0d\u89c1\n\n${omitted}\n[Image converted from image/bmp to image/png.]`, id: "u2" },
  });
  const rows = projector
    .getSnapshot()
    .rows.window.filter((item) => item.kind === "userInput");
  assert.equal(rows.at(-1)?.kind === "userInput" ? rows.at(-1)?.text : "", `\u770b\u4e0d\u89c1\n\n${omitted}`);
});

test("dragged text files are included in the model prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-"));
  const file = join(dir, "note.txt");
  await writeFile(file, "hello from the dropped file");
  try {
    const session = new FakePiSession("s");
    const queue = new HostQueue();
    const noted: string[][] = [];
    const bridge = new CommandBridge(session, queue, undefined, (refs) => {
      noted.push(refs.map((item) => item.ref));
    });
    const attachment = {
      type: "file" as const,
      path: file,
      filename: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 26,
    };
    await bridge.admitSend({
      text: "look",
      clientId: "c",
      commandId: "1",
      delivery: "startNow",
      streaming: false,
      attachments: [attachment],
    });
    assert.match(session.prompts[0] ?? "", /hello from the dropped file/);
    assert.match(session.prompts[0] ?? "", /note\.txt/);
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
    assert.match(session.prompts[1] ?? "", /hello from the dropped file/);
    assert.deepEqual(noted, [[file], [file]]);
    const projector = new PiToV4Projector("s", "e1");
    projector.noteUserAttachments([
      { ref: file, fileName: "note.txt", mime: "text/plain", bytes: 26 },
    ]);
    projector.apply({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: session.prompts[0] ?? "" }],
        id: "u1",
      },
    });
    const row = projector.getSnapshot().rows.window.find((item) => item.kind === "userInput");
    assert.equal(row?.kind === "userInput" ? row.text : "", "look");
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

test("agent_end while Pi is still streaming does not prompt or crash", async () => {
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
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => {
    crashes.push(error);
  };
  process.on("unhandledRejection", onCrash);
  try {
    const hosted = await registry.create({ workspacePath: root });
    const fake = fakes.get(hosted.sessionId);
    assert.ok(fake);
    await hosted.bridge.admitSend({
      text: "hi",
      clientId: "c",
      commandId: "q1",
      delivery: "queue",
      streaming: true,
    });
    fake.isStreaming = true;
    fake.prompt = async () => {
      throw new Error(
        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      );
    };
    fake.emit({ type: "agent_end" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(crashes, []);
    assert.deepEqual(fake.prompts, []);
    assert.equal(hosted.queue.snapshot().items[0]?.text, "hi");
  } finally {
    process.off("unhandledRejection", onCrash);
    await rm(root, { recursive: true, force: true });
  }
});

test("queued text is visible and removable before it is sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  try {
    const hosted = await registry.create({ workspacePath: root });
    const queuedTexts: string[][] = [];
    hosted.onDeltas((deltas) => {
      for (const delta of deltas) {
        const parsed = conversationDeltaSchema.safeParse(delta);
        assert.equal(parsed.success, true);
        if (!parsed.success || parsed.data.op !== "state.updated" || !parsed.data.patch.queue)
          continue;
        queuedTexts.push(parsed.data.patch.queue.items.map((item) => item.text));
      }
    });
    await hosted.bridge.admitSend({
      text: "hold this",
      clientId: "c",
      commandId: "q1",
      delivery: "queue",
      streaming: true,
    });
    assert.deepEqual(queuedTexts, []);
    hosted.projector.replaceQueue(hosted.queue.snapshot());
    assert.deepEqual(queuedTexts.at(-1), ["hold this"]);
    const id = hosted.queue.snapshot().items[0]?.queueItemId;
    assert.equal(typeof id, "string");
    assert.ok(hosted.queue.remove(id ?? ""));
    hosted.projector.replaceQueue(hosted.queue.snapshot());
    assert.deepEqual(queuedTexts.at(-1), []);
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

test("a follow-up while Pi is still streaming is queued instead of prompting", async () => {
  const session = new FakePiSession("s");
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue);
  session.isStreaming = true;
  const queued = await bridge.admitSend({
    text: "hi",
    clientId: "c",
    commandId: "2",
    delivery: "startNow",
    streaming: false,
  });
  assert.equal(queued.kind, "queued");
  assert.deepEqual(session.prompts, []);
  assert.equal(await bridge.drainNext(), false);
  assert.equal(queue.snapshot().items.length, 1);
  session.isStreaming = false;
  assert.equal(await bridge.drainNext(), true);
  assert.deepEqual(session.prompts, ["hi"]);
});

test("a rejected drain puts the message back on the queue", async () => {
  const session = new FakePiSession("s");
  const queue = new HostQueue();
  const bridge = new CommandBridge(session, queue);
  await bridge.admitSend({
    text: "later",
    clientId: "c",
    commandId: "1",
    delivery: "queue",
    streaming: true,
  });
  session.isStreaming = false;
  session.prompt = async () => {
    throw new Error(
      "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
    );
  };
  await assert.rejects(() => bridge.drainNext(), /already processing/);
  assert.equal(queue.snapshot().items[0]?.text, "later");
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
    assert.equal(selectPayload.questions?.[0]?.question, "Pick");
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

test("structured ask keeps the question apart from option previews", async () => {
  const ui = new ExtensionUiHost();
  const extensionUi = createHostExtensionUi(ui, (event) => {
    ui.handle(event);
  }) as ReturnType<typeof createHostExtensionUi> & {
    ask: (
      questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string; preview?: string }>;
      }>,
    ) => Promise<
      Array<{ question: string; answer: string; preview?: string; custom: boolean }> | undefined
    >;
  };
  const pending = extensionUi.ask([
    {
      question: "固定出口怎么做？",
      header: "出口",
      options: [
        { label: "多协议", description: "工作量大", preview: "curl socks" },
        { label: "只管理", description: "只改入口", preview: "POST /api" },
      ],
    },
  ]);
  const payload = ui.snapshot().pending[0]?.payload;
  assert.equal(payload?.kind, "userInput");
  if (payload?.kind === "userInput") {
    assert.equal(payload.questions?.[0]?.question, "固定出口怎么做？");
    assert.equal(payload.questions?.[0]?.header, "出口");
    assert.equal(payload.questions?.[0]?.options[0]?.label, "多协议");
    assert.equal(payload.questions?.[0]?.options[0]?.description, "工作量大");
    assert.equal(payload.questions?.[0]?.options[0]?.preview, "curl socks");
    assert.equal(payload.questions?.[0]?.options[0]?.value, "多协议");
    assert.equal(payload.prompt.includes("curl"), false);
    assert.equal(payload.prompt.includes("preview"), false);
  }
  const id = ui.snapshot().pending[0]?.interactionId ?? "";
  assert.equal(
    ui.respond({
      id,
      content: { answer_0: "多协议", answers: { "固定出口怎么做？": "多协议" } },
    }),
    true,
  );
  const answers = await pending;
  assert.equal(answers?.[0]?.answer, "多协议");
  assert.equal(answers?.[0]?.preview, "curl socks");
  assert.equal(answers?.[0]?.custom, false);
});

test("host extension theme is plain text so plan progress can be listed", () => {
  const ui = new ExtensionUiHost();
  const extensionUi = createHostExtensionUi(ui, (event) => {
    ui.handle(event);
  });
  extensionUi.setStatus("plannotator", extensionUi.theme.fg("warning", "⏸ plan"));
  extensionUi.setWidget("plannotator-progress", [
    extensionUi.theme.fg("success", "☑ ") +
      extensionUi.theme.fg("muted", extensionUi.theme.strikethrough("done")),
    `${extensionUi.theme.fg("muted", "☐ ")}next`,
  ]);
  const snap = ui.snapshot();
  assert.equal(snap.statuses[0]?.text, "⏸ plan");
  assert.deepEqual(snap.widgets[0]?.lines, ["☑ done", "☐ next"]);
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

test("switching the session to full access allows the waiting tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const session = await registry.create({ workspacePath: root });
  const pending = session.requestConfirm("Bash", "run");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.ui.snapshot().pending.length, 1);
  session.setCollaborationMode("yolo");
  assert.equal(await pending, true);
  assert.equal(session.ui.snapshot().pending.length, 0);
  assert.equal(session.projector.getSnapshot().config.mode, "yolo");
  assert.equal(session.ui.autoConfirm, true);
  session.setCollaborationMode("build");
  assert.equal(session.ui.autoConfirm, false);
  assert.equal(session.projector.getSnapshot().config.mode, "build");
  await rm(root, { recursive: true, force: true });
});

test("gateTool denies", async () => {
  await assert.rejects(() => gateTool(async () => "deny", "bash", {}), /permission denied/);
  await gateTool(async () => "allow", "read", {});
});

test("a running branch summary blocks another branch on the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => new FakePiSession(input.sessionId, input.sessionFile),
  });
  const parent = await registry.create({ workspacePath: root });
  parent.publishCustomTitle("原题");
  parent.noteBranchSummary(true);
  assert.equal(
    parent.projector
      .getSnapshot()
      .rows.window.some(
        (row) =>
          row.kind === "timelineMarker" &&
          row.marker.type === "branchSummary" &&
          row.marker.status === "running",
      ),
    true,
  );
  await assert.rejects(registry.fork(parent.sessionId, "a1"), (error: unknown) => {
    assert.equal((error as { reasonCode?: string }).reasonCode, "guard.sessionTreeBusy");
    return true;
  });
  await assert.rejects(
    registry.resumeIntoNewSession(parent.sessionId, { entryId: "u1", summarize: true }),
    (error: unknown) => {
      assert.equal((error as { reasonCode?: string }).reasonCode, "guard.sessionTreeBusy");
      return true;
    },
  );
  assert.throws(
    () => parent.deleteSessionBranch("side"),
    (error: unknown) => {
      assert.equal((error as { reasonCode?: string }).reasonCode, "guard.sessionTreeBusy");
      return true;
    },
  );
  parent.noteBranchSummary(false);
  assert.equal(
    parent.projector
      .getSnapshot()
      .rows.window.some(
        (row) =>
          row.kind === "timelineMarker" &&
          row.marker.type === "branchSummary" &&
          row.marker.status === "running",
      ),
    false,
  );
  const child = await registry.fork(parent.sessionId, "a1");
  assert.notEqual(child.sessionId, parent.sessionId);
  assert.equal(child.projector.getSnapshot().meta.title, "分支-原题");
  await rm(root, { recursive: true, force: true });
});

test("live assistant row adopts the persisted tree entry id", () => {
  const projector = new PiToV4Projector("s", "e");
  projector.apply({ type: "agent_start" });
  projector.apply({ type: "message_start", message: { role: "user", content: "hi" } });
  projector.apply({ type: "message_start", message: { role: "assistant" } });
  projector.apply({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "yo" },
  });
  projector.apply({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
  });
  const before = projector.getSnapshot().rows.window.find((row) => row.kind === "assistantText");
  assert.equal(before?.entityId?.startsWith("row:"), true);
  projector.bindPersistedEntry("entry-a");
  const after = projector.getSnapshot().rows.window.find((row) => row.kind === "assistantText");
  assert.equal(after && after.kind === "assistantText" ? after.entityId : "", "entry-a");
  assert.equal(after && after.kind === "assistantText" ? after.text : "", "yo");
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
  assert.equal(
    assistant && assistant.kind === "assistantText" ? assistant.actions?.canRetry : false,
    true,
  );
  const userRows = parent.projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput");
  assert.equal(userRows.length, 2);
  assert.equal(
    userRows.every((row) => row.kind === "userInput" && row.actions?.canEdit === true),
    true,
  );
  parent.projector.setFeedback(assistant?.entityId ?? "", "like");
  const liked = parent.projector
    .getSnapshot()
    .rows.window.find((row) => row.entityId === assistant?.entityId);
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

test("summarized navigate reloads the branch summary and cancel keeps the leaf", async () => {
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
  const fake = fakes.get(parent.sessionId)!;
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u1", content: "keep" },
  });
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u2", content: "drop" },
  });
  fake.contextEventsList = [{ type: "branch_summary", summary: "dropped the rest" }];
  await parent.navigateTree("u2", { summarize: true, customInstructions: "keep the decision" });
  assert.deepEqual(fake.navigateOptions, {
    summarize: true,
    customInstructions: "keep the decision",
  });
  const marker = parent.projector
    .getSnapshot()
    .rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    marker && marker.kind === "timelineMarker" && marker.marker.type === "branchSummary"
      ? marker.marker.summary
      : "",
    "dropped the rest",
  );
  assert.equal(
    parent.projector.getSnapshot().rows.window.some((row) => row.kind === "userInput"),
    false,
  );
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u3", content: "stay" },
  });
  fake.summaryAborted = true;
  const cancelled = await parent.navigateTree("u3", { summarize: true });
  assert.equal(cancelled?.cancelled, true);
  assert.equal(
    parent.projector
      .getSnapshot()
      .rows.window.some((row) => row.kind === "userInput" && row.text === "stay"),
    true,
  );
  assert.equal(
    parent.projector
      .getSnapshot()
      .rows.window.some(
        (row) =>
          row.kind === "timelineMarker" &&
          row.marker.type === "branchSummary" &&
          row.marker.status === "running",
      ),
    false,
  );
  await rm(root, { recursive: true, force: true });
});

test("resumeAt replays the live leaf and stop only cancels the summary", async () => {
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
  const fake = fakes.get(parent.sessionId)!;
  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u1", content: "old" },
  });
  fake.contextEventsList = [
    { type: "message_start", message: { role: "user", id: "kept", content: "kept" } },
  ];
  fake.editorText = "later";
  const resumed = await parent.resumeAt({
    entryId: "u2",
    role: "user",
    text: "later",
    summarize: false,
  });
  assert.equal(resumed.editorText, "later");
  assert.equal(resumed.cancelled, false);
  assert.deepEqual(
    parent.projector
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "userInput")
      .map((row) => (row.kind === "userInput" ? row.text : "")),
    ["kept"],
  );

  parent.projector.apply({
    type: "message_start",
    message: { role: "user", id: "u9", content: "stay" },
  });
  fake.holdNavigate = true;
  fake.summaryAborted = false;
  fake.editorText = undefined;
  const pending = parent.resumeAt({ entryId: "a1", summarize: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await parent.abort();
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.equal(fake.summaryAborted, true);
  assert.equal(fake.aborted, false);
  assert.equal(
    parent.projector
      .getSnapshot()
      .rows.window.some((row) => row.kind === "userInput" && row.text === "stay"),
    true,
  );
  assert.equal(parent.projector.getSnapshot().control.canStop, false);
  await rm(root, { recursive: true, force: true });
});

test("resumeIntoNewSession keeps the parent and cancels on its stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      if (fakes.size === 0) {
        fake.tree = [
          {
            id: "leaf",
            parentId: null,
            role: "assistant",
            preview: "yo",
            depth: 0,
            active: true,
            leaf: true,
          },
        ];
        fake.branchFrom = () => ({
          sessionId: "child-1",
          sessionFile: join(root, "child-1.jsonl"),
        });
      }
      if (input.sessionId === "child-1" && !fakes.has("child-1")) fake.holdSummary = true;
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  const parent = await registry.create({ workspacePath: root });
  const created = await registry.resumeIntoNewSession(parent.sessionId, {
    entryId: "u1",
    role: "user",
    text: "later",
    summarize: true,
  });
  assert.equal(created.cancelled, false);
  if (created.cancelled) throw new Error("expected the branch to open before the summary");
  assert.equal(parent.projector.getSnapshot().control.canStop, false);
  assert.equal(created.hosted.projector.getSnapshot().control.canStop, true);
  assert.equal(fakes.get(parent.sessionId)?.navigatedTo.length, 0);
  assert.deepEqual(fakes.get("child-1")?.navigatedTo, ["u1"]);
  assert.equal(fakes.get("child-1")?.summaryStarted, true);
  await created.hosted.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(registry.get("child-1"), created.hosted);
  assert.equal(fakes.get("child-1")?.summaryAborted, true);
  assert.equal(created.hosted.projector.getSnapshot().control.canStop, false);
  await registry.delete("child-1");

  parent.projector.setConfig({ mode: "yolo" });
  parent.sessionAllows.add("bash");
  const again = await registry.resumeIntoNewSession(parent.sessionId, {
    entryId: "u1",
    summarize: false,
  });
  assert.equal(again.cancelled, false);
  if (again.cancelled) throw new Error("expected a new session");
  assert.equal(again.hosted.projector.getSnapshot().config.mode, "yolo");
  assert.equal(again.hosted.ui.autoConfirm, true);
  assert.equal(await again.hosted.requestConfirm("bash", "run"), true);
  assert.equal(again.hosted.ui.snapshot().pending.length, 0);
  assert.equal(again.sessionId, "child-1");
  assert.equal(again.editorText, undefined);
  assert.deepEqual(fakes.get("child-1")?.navigatedTo, ["u1"]);
  assert.equal(fakes.get(parent.sessionId)?.navigatedTo.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("a finished branch summary stays on the new session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      if (fakes.size === 0) {
        fake.tree = [
          {
            id: "leaf",
            parentId: null,
            role: "assistant",
            preview: "yo",
            depth: 0,
            active: true,
            leaf: true,
          },
        ];
        fake.branchFrom = () => ({
          sessionId: "child-summary",
          sessionFile: join(root, "child-summary.jsonl"),
        });
      }
      fake.contextEventsList = [
        { type: "message_start", message: { role: "user", id: "kept", content: "kept" } },
      ];
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  const parent = await registry.create({ workspacePath: root });
  const created = await registry.resumeIntoNewSession(parent.sessionId, {
    entryId: "u1",
    summarize: true,
  });
  if (created.cancelled) throw new Error("expected a new session");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const marker = created.hosted.projector
    .getSnapshot()
    .rows.window.find(
      (row) => row.kind === "timelineMarker" && row.marker.type === "branchSummary",
    );
  assert.equal(
    marker && marker.kind === "timelineMarker" && marker.marker.type === "branchSummary"
      ? marker.marker.summary
      : "",
    "dropped the rest",
  );
  assert.equal(
    created.hosted.projector.getSnapshot().rows.window.some((row) => row.kind === "userInput"),
    true,
  );
  await rm(root, { recursive: true, force: true });
});

test("conversation fork keeps host extensions that spawn omits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-"));
  const seen: Array<{ sessionId: string; parentSessionId?: string; omitHostExtensions?: boolean }> =
    [];
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      seen.push({
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId,
        omitHostExtensions: input.omitHostExtensions,
      });
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      fake.branchFrom = () => ({
        sessionId: "branched",
        sessionFile: join(root, "branched.jsonl"),
      });
      return fake;
    },
  });
  const parent = await registry.create({ workspacePath: root });
  const child = await registry.fork(parent.sessionId, "a1");
  const spawned = await registry.spawn(parent.sessionId);
  assert.equal(child.parentSessionId, parent.sessionId);
  assert.equal(child.sessionId, "branched");
  assert.equal(seen[1]?.parentSessionId, parent.sessionId);
  assert.equal(seen[1]?.omitHostExtensions, undefined);
  assert.equal(spawned.parentSessionId, parent.sessionId);
  assert.equal(seen[2]?.omitHostExtensions, true);
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
  assert.equal(
    listed.some((item) => item.sessionId === empty.sessionId),
    false,
  );
  assert.equal(listed.map((item) => item.sessionId).join(","), "01fork,sess_chat");
  assert.equal(listed.find((item) => item.sessionId === "sess_chat")?.title, "hello pi");
  const found = await registry.find("sess_chat");
  assert.equal(found?.sessionId, "sess_chat");
  const opened = await registry.create({ workspacePath: root, sessionId: "sess_chat" });
  const kinds = opened.projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.ok(kinds.includes("userInput"));
  assert.ok(kinds.includes("assistantText"));
  opened.onDeltas(() => undefined);
  const redrawn: Array<{ op: string; kind?: string }> = [];
  opened.onDeltas((deltas) => {
    for (const delta of deltas) {
      redrawn.push({
        op: delta.op,
        ...(delta.op === "row.appended" ? { kind: delta.row.kind } : {}),
      });
    }
  });
  opened.reloadHistory(await readFile(opened.sessionFile, "utf8"));
  assert.ok(redrawn.some((delta) => delta.op === "row.appended" && delta.kind === "userInput"));
  opened.dispose();
  assert.equal(registry.get("sess_chat"), undefined);
  await writeFile(
    opened.sessionFile,
    `${await readFile(opened.sessionFile, "utf8")}\n{"type":"message","id":"u2","timestamp":"2026-01-02T03:04:08.000Z","message":{"role":"user","content":[{"type":"text","text":"later"}]}}`,
  );
  const reopened = await registry.create({ workspacePath: root, sessionId: "sess_chat" });
  assert.notEqual(reopened, opened);
  const texts = reopened.projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput")
    .map((row) => ("text" in row ? row.text : ""));
  assert.deepEqual(texts, ["hello pi", "later"]);
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

test("picode subagent jsonl stays out of the session list but is identifiable", async () => {
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
  const parentFile = join(dir, "2026-01-02T03-04-05Z_sess_parent.jsonl");
  await mkdir(join(dir, "2026-01-02T03-04-05Z_sess_parent", "picode-subagent"), {
    recursive: true,
  });
  await writeFile(
    parentFile,
    [
      '{"type":"session","id":"sess_parent","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"review"}]}}',
    ].join("\n"),
  );
  await writeFile(
    join(
      dir,
      "2026-01-02T03-04-05Z_sess_parent",
      "picode-subagent",
      "2026-01-02T03-04-06Z_01child.jsonl",
    ),
    [
      '{"type":"session","id":"01child","timestamp":"2026-01-02T03:04:06.000Z","cwd":"/work"}',
      '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"Repo: hidden"}]}}',
    ].join("\n"),
  );
  const listed = await registry.list(cwd);
  assert.deepEqual(
    listed.map((item) => item.sessionId),
    ["sess_parent"],
  );
  const hidden = await registry.listPicodeSubagentSessionIds(cwd);
  assert.equal(hidden.has("01child"), true);
  assert.equal(hidden.has("sess_parent"), false);
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
  assert.deepEqual(listed.map((item) => item.sessionId).sort(), ["sess_old", "sess_ssh"]);
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
