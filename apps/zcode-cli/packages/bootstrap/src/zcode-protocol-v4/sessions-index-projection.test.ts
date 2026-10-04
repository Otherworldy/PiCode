import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeVisibleSessionTitle } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexProjection } from "./sessions-index-projection.js";

function titled(title: string, titleSource: "generated" | "custom" = "generated") {
  return {
    sessionId: "s1",
    meta: { title, titleSource },
    control: { phase: "completedSuccess", sessionEnded: true },
    rows: { window: [] },
    backgroundWorks: [],
    pendingInteractions: [],
    goal: null,
  } as unknown as ConversationSnapshot;
}

const extra = { createdAt: 1, lastActivityAt: 2 };

test("live summary keeps a worktree directory", () => {
  const projection = new SessionsIndexProjection("D:/repo", "epoch");
  const deltas = projection.upsertFromConversation(
    {
      sessionId: "s1",
      meta: { title: "todo", titleSource: "generated" },
      control: { phase: "running", sessionEnded: false },
      rows: { window: [] },
      backgroundWorks: [],
      pendingInteractions: [],
      goal: null,
    } as unknown as ConversationSnapshot,
    {
      createdAt: 1,
      lastActivityAt: 2,
      workingDirectory: "D:/repo/.worktrees/todo-1",
    },
  );
  assert.equal(deltas[0]?.op, "session.upserted");
  if (deltas[0]?.op !== "session.upserted") return;
  assert.equal(deltas[0].session.workingDirectory, "D:/repo/.worktrees/todo-1");
});

test("a slash command does not replace or stick as the session title", () => {
  const kept = new SessionsIndexProjection("ws", "epoch");
  kept.upsertFromConversation(titled("修登录"), extra);
  assert.equal(kept.upsertFromConversation(titled("/plannotator-plan-mode"), extra).length, 0);
  assert.equal(kept.getSnapshot().sessions[0]?.title, "修登录");

  const replaced = new SessionsIndexProjection("ws", "epoch");
  replaced.upsertFromConversation(titled("/plannotator-plan-mode"), extra);
  const fixed = replaced.upsertFromConversation(titled("修登录"), extra);
  assert.equal(fixed[0]?.op, "session.upserted");
  if (fixed[0]?.op !== "session.upserted") return;
  assert.equal(fixed[0].session.title, "修登录");
});

test("stored slash-command title falls through to the next real user message", () => {
  const title = resolveZCodeVisibleSessionTitle({
    title: "/plannotator-plan-mode",
    messages: [
      {
        info: { role: "user", id: "u0", time: { created: 1, updated: 1 } },
        parts: [{ type: "text", text: "/plannotator-plan-mode" }],
      },
      {
        info: { role: "user", id: "u1", time: { created: 2, updated: 2 } },
        parts: [{ type: "text", text: "修登录" }],
      },
    ] as never,
  });
  assert.equal(title, "修登录");
});
