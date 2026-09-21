import assert from "node:assert/strict";
import test from "node:test";
import { PiToV4Projector } from "./projector.js";
import { readPiJsonl } from "./jsonl-history.js";

const sample = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  '{"type":"message","id":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":[{"type":"text","text":"just say pong"}]}}',
  '{"type":"message","id":"a1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"ok"},{"type":"text","text":"pong"}]}}',
  '{"type":"message","id":"u2","timestamp":"2026-01-02T03:05:00.000Z","message":{"role":"user","content":[{"type":"text","text":"ls please"}]}}',
  '{"type":"message","id":"a2","timestamp":"2026-01-02T03:05:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"listing"},{"type":"toolCall","id":"c1","name":"ls","arguments":{"path":"."}}]}}',
  '{"type":"message","id":"t1","timestamp":"2026-01-02T03:05:02.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"ls","content":[{"type":"text","text":"(empty)"}],"isError":false}}',
  '{"type":"message","id":"a3","timestamp":"2026-01-02T03:05:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"empty dir"}]}}',
].join("\n");

test("summarize skips header-only jsonl", () => {
  const parsed = readPiJsonl(
    '{"type":"session","timestamp":"2026-01-02T03:04:05.000Z","cwd":"C:\\\\work"}',
  );
  assert.equal(parsed.summary, null);
  assert.equal(parsed.events.length, 0);
});

test("summarize uses first user text and last assistant preview", () => {
  const { summary } = readPiJsonl(sample);
  assert.ok(summary);
  assert.equal(summary.title, "just say pong");
  assert.equal(summary.cwd, "C:\\work");
  assert.equal(summary.lastAssistantPreview, "empty dir");
  assert.equal(summary.createdAt, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(summary.lastActivityAt, Date.parse("2026-01-02T03:05:03.000Z"));
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
