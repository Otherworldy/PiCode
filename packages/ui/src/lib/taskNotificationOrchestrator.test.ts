import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { collectTerminalTaskNotificationPayloads } from "./taskNotificationOrchestrator.js";

function session(
  phase: SessionSummary["phase"],
  lastAssistantPreview?: string,
): SessionSummary {
  return {
    sessionId: "s",
    workspaceId: "ws",
    title: "旧标题",
    phase,
    sessionEnded: phase === "completedSuccess",
    hasBackgroundWork: false,
    lastActivityAt: 2,
    createdAt: 1,
    ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
  };
}

const formatMessage = ((descriptor: { id: string }, values?: { title?: string }) => {
  if (descriptor.id === "notification.taskWithTitle") return `任务：${values?.title ?? ""}`;
  return descriptor.id;
}) as Parameters<typeof collectTerminalTaskNotificationPayloads>[0]["formatMessage"];

test("completion reminder uses the latest message", () => {
  const [payload] = collectTerminalTaskNotificationPayloads({
    previousBySessionId: new Map([["s", session("running")]]),
    sessions: [session("completedSuccess", "最新回复")],
    formatMessage,
  });
  assert.equal(payload?.body, "最新回复");
});

test("completion reminder falls back to the session title", () => {
  const [payload] = collectTerminalTaskNotificationPayloads({
    previousBySessionId: new Map([["s", session("running")]]),
    sessions: [session("completedSuccess")],
    formatMessage,
  });
  assert.equal(payload?.body, "任务：旧标题");
});
