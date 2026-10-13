import assert from "node:assert/strict";
import test from "node:test";
import { PiToV4Projector } from "./projector.js";
import { readPiJsonl, shouldApplyStoredSessionTitle } from "./jsonl-history.js";

const sample = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"just say pong"}]}}',
  '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"ok"},{"type":"text","text":"pong"}]}}',
  '{"type":"message","id":"u2","timestamp":"2026-01-02T03:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"ls please"}]}}',
  '{"type":"message","id":"a2","timestamp":"2026-01-02T03:05:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"listing"},{"type":"toolCall","id":"c1","name":"ls","arguments":{"path":"."}}]}}',
  '{"type":"message","id":"t1","timestamp":"2026-01-02T03:05:02.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"ls","content":[{"type":"text","text":"(empty)"}],"isError":false}}',
  '{"type":"message","id":"a3","timestamp":"2026-01-02T03:05:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"empty dir"}]}}',
].join("\n");

test("replay does not publish the first-message title", () => {
  const events = readPiJsonl(sample).events;
  const projector = new PiToV4Projector("s1", "e1");
  projector.setTitle("修登录", "generated");
  projector.replay(events);
  assert.equal(projector.getSnapshot().meta.title, "修登录");
  assert.equal(projector.getSnapshot().meta.titleSource, "generated");
  const live = new PiToV4Projector("s1", "e1");
  for (const event of events) live.apply(event);
  assert.equal(live.getSnapshot().meta.title, "just say pong");
});

test("stored history title does not roll a summary back to the first message", () => {
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "修登录",
      currentTitleSource: "generated",
      storedTitle: "just say pong",
      storedTitleNamed: false,
    }),
    false,
  );
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "just say pong",
      currentTitleSource: "generated",
      storedTitle: "修登录",
      storedTitleNamed: true,
    }),
    true,
  );
  assert.equal(
    shouldApplyStoredSessionTitle({
      currentTitle: "",
      currentTitleSource: "default",
      storedTitle: "just say pong",
      storedTitleNamed: false,
    }),
    true,
  );
});

test("replay matches per-event apply", () => {
  const events = readPiJsonl(sample).events;
  const stepwise = new PiToV4Projector("s1", "e1");
  for (const event of events) stepwise.apply(event);
  const bulk = new PiToV4Projector("s1", "e1");
  bulk.replay(events);
  const view = (rows: ReturnType<PiToV4Projector["getSnapshot"]>["rows"]["window"]) =>
    rows.map((row) => ({
      kind: row.kind,
      text: "text" in row ? row.text : undefined,
      actions: "actions" in row ? row.actions : undefined,
    }));
  assert.deepEqual(view(bulk.getSnapshot().rows.window), view(stepwise.getSnapshot().rows.window));
});

test("summarize skips header-only jsonl", () => {
  const parsed = readPiJsonl(
    '{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  );
  assert.equal(parsed.summary, null);
  assert.equal(parsed.events.length, 0);
});

test("summarize skips a bare slash command and a command session name", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
    '{"type":"session_info","name":"/plannotator-plan-mode"}',
    '{"type":"message","id":"u0","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"/plannotator-plan-mode"}]}}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"修登录"}]}}',
  ].join("\n");
  assert.equal(readPiJsonl(content).summary?.title, "修登录");
});

test("summarize drops Pi image resize notes from the title", () => {
  const note =
    "[Image: original 2560x1392, displayed at 2000x1088. Multiply coordinates by 1.28 to map to original image.]";
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z"}',
    `{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"\u770b\u8fd9\u5f20\\n\\n${note}"}]}}`,
  ].join("\n");
  assert.equal(readPiJsonl(content).summary?.title, "\u770b\u8fd9\u5f20");
});

test("summarize uses first user text and last assistant preview", () => {
  const { summary } = readPiJsonl(sample);
  assert.ok(summary);
  assert.equal(summary.title, "just say pong");
  assert.equal(summary.sessionId, "s1");
  assert.equal(summary.cwd, "C:\\work");
  assert.equal(summary.lastAssistantPreview, "empty dir");
  assert.equal(summary.createdAt, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(summary.lastActivityAt, Date.parse("2026-01-02T03:05:03.000Z"));
});

test("fork keeps the new header time and ignores older copied messages", () => {
  const content = [
    '{"type":"session","id":"child","timestamp":"2026-09-24T05:13:57.799Z","cwd":"/work"}',
    '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-09-24T03:21:15.267Z","message":{"role":"user","content":[{"type":"text","text":"ping2"}]}}',
    '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-09-24T03:21:17.568Z","message":{"role":"assistant","content":[{"type":"text","text":"pong2"}]}}',
    '{"type":"custom","id":"c1","parentId":"a1","timestamp":"2026-09-24T05:13:47.239Z"}',
    '{"type":"message","id":"u2","parentId":"a1","timestamp":"2026-09-24T05:14:02.184Z","message":{"role":"user","content":[{"type":"text","text":"ping3"}]}}',
  ].join("\n");
  const { summary } = readPiJsonl(content);
  assert.equal(summary?.createdAt, Date.parse("2026-09-24T05:13:57.799Z"));
  assert.equal(summary?.lastActivityAt, Date.parse("2026-09-24T05:14:02.184Z"));
});

test("replay follows the active leaf and drops the edited-away branch", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\work"}',
    '{"type":"message","id":"sys","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"system","content":"ctx"}}',
    '{"type":"message","id":"u1","parentId":"sys","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"ping"}]}}',
    '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-02T03:04:08.000Z","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}',
    '{"type":"message","id":"u2","parentId":"sys","timestamp":"2026-01-02T03:04:09.000Z","message":{"role":"user","content":[{"type":"text","text":"ping2"}]}}',
    '{"type":"message","id":"a2","parentId":"u2","timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"pong2"}]}}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const texts = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "userInput" || row.kind === "assistantText")
    .map((row) => ("text" in row ? row.text : ""));
  assert.deepEqual(texts, ["ping2", "pong2"]);
});

test("replay keeps a compaction summary", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"ping"}]}}',
    '{"type":"compaction","id":"k1","parentId":"u1","timestamp":"2026-01-02T03:04:07.000Z","summary":"user said ping","tokensBefore":40}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1");
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const marker = projector.getSnapshot().rows.window.find((row) => row.kind === "timelineMarker");
  assert.equal(
    marker && marker.kind === "timelineMarker" && marker.marker.type === "compact"
      ? marker.marker.summary
      : "",
    "user said ping",
  );
});

test("settled jsonl uses message timestamps for work duration", () => {
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(sample).events) projector.apply(event);
  const headers = projector.getSnapshot().rows.window.filter((row) => row.kind === "turnHeader");
  const last = headers.at(-1);
  assert.equal(last && last.kind === "turnHeader" ? last.state : "", "completedSuccess");
  assert.equal(last && last.kind === "turnHeader" ? last.activeMs : -1, 3_000);
  assert.equal(projector.getSnapshot().control.phase === "running", false);
});

test("live subagent jsonl stays open and keeps the file clock", () => {
  const content = [
    '{"type":"session","id":"child","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"explore"}]}}',
    '{"type":"message","id":"a1","timestamp":"2026-01-02T03:06:42.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"grep","arguments":{"pattern":"todo"}}]}}',
  ].join("\n");
  const projector = new PiToV4Projector("child", "e1");
  for (const event of readPiJsonl(content, { settle: false }).events) projector.apply(event);
  const header = projector.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
  assert.equal(header && header.kind === "turnHeader" ? header.state : "", "running");
  assert.equal(
    header && header.kind === "turnHeader" ? header.startedAt : 0,
    Date.parse("2026-01-02T03:04:06.000Z"),
  );
  assert.equal(header && header.kind === "turnHeader" ? header.endedAt : 0, undefined);
  assert.equal(projector.getSnapshot().control.phase, "running");
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.status : "", "running");
});

test("replay hydrates user, assistant, tools into projector", () => {
  const { events } = readPiJsonl(sample);
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of events) projector.apply(event);
  const kinds = projector.getSnapshot().rows.window.map((row) => row.kind);
  assert.ok(kinds.includes("userInput"));
  assert.ok(kinds.includes("assistantText"));
  assert.ok(kinds.includes("toolCall"));
  const tool = projector.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool && tool.kind === "toolCall" ? tool.status : undefined, "success");
  assert.equal(projector.getSnapshot().control.phase === "running", false);
});

test("replay keeps later assistant text after tools and plugin messages", () => {
  const content = [
    '{"type":"session","id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\work"}',
    '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"export done?"}]}}',
    '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still exporting"}]}}',
    '{"type":"custom_message","id":"p1","customType":"background-bash-task","display":true,"content":"background task done","timestamp":"2026-01-02T03:04:08.000Z"}',
    '{"type":"message","id":"a2","timestamp":"2026-01-02T03:04:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"export finished"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"wsl -l"}}]}}',
    '{"type":"message","id":"t1","timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}}',
    '{"type":"message","id":"a3","timestamp":"2026-01-02T03:04:11.000Z","message":{"role":"assistant","content":[{"type":"text","text":"vhdx removed"}]}}',
    '{"type":"message","id":"b1","timestamp":"2026-01-02T03:04:12.000Z","message":{"role":"bashExecution","command":"docker ps","output":"none","exitCode":0}}',
  ].join("\n");
  const projector = new PiToV4Projector("s1", "e1", { profile: "continuous" });
  for (const event of readPiJsonl(content).events) projector.apply(event);
  const texts = projector
    .getSnapshot()
    .rows.window.filter((row) => row.kind === "assistantText")
    .map((row) => (row.kind === "assistantText" ? row.text : ""));
  assert.deepEqual(texts, [
    "still exporting",
    "background task done",
    "export finished",
    "vhdx removed",
  ]);
  const tools = projector.getSnapshot().rows.window.filter((row) => row.kind === "toolCall");
  assert.equal(tools.length, 2);
  assert.equal(tools.every((row) => row.kind === "toolCall" && row.status === "success"), true);
});
