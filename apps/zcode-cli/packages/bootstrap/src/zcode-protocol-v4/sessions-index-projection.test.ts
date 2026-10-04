import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexProjection } from "./sessions-index-projection.js";

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
