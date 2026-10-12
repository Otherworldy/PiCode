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

test("a finished ask does not keep the waiting badge", () => {
  const projection = new SessionsIndexProjection("ws", "epoch");
  const deltas = projection.upsertFromConversation(
    {
      sessionId: "s1",
      meta: { title: "问", titleSource: "generated" },
      control: { phase: "running", sessionEnded: false },
      rows: {
        window: [
          {
            kind: "toolCall",
            rowId: 1,
            toolCallId: "c1",
            toolName: "AskUserQuestion",
            status: "success",
            inputText: "",
          },
        ],
      },
      backgroundWorks: [],
      pendingInteractions: [
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
      ],
      goal: null,
    } as unknown as ConversationSnapshot,
    extra,
  );
  assert.equal(deltas[0]?.op, "session.upserted");
  if (deltas[0]?.op !== "session.upserted") return;
  assert.equal(deltas[0].session.pendingInteraction, undefined);
  assert.equal(deltas[0].session.pendingInteractionSummary, undefined);
});

test("a running ask still shows the waiting badge", () => {
  const projection = new SessionsIndexProjection("ws", "epoch");
  const deltas = projection.upsertFromConversation(
    {
      sessionId: "s1",
      meta: { title: "问", titleSource: "generated" },
      control: { phase: "running", sessionEnded: false },
      rows: {
        window: [
          {
            kind: "toolCall",
            rowId: 1,
            toolCallId: "c1",
            toolName: "AskUserQuestion",
            status: "running",
            inputText: "",
          },
        ],
      },
      backgroundWorks: [],
      pendingInteractions: [
        {
          interactionId: "q1",
          kind: "userInput",
          anchorRowId: null,
          createdAt: 1,
          payload: {
            kind: "userInput",
            prompt: "哪一种？",
            freeText: false,
            toolName: "AskUserQuestion",
            questions: [
              {
                question: "哪一种？",
                header: "Ask",
                options: [{ value: "A", label: "A" }],
              },
            ],
          },
        },
      ],
      goal: null,
    } as unknown as ConversationSnapshot,
    extra,
  );
  assert.equal(deltas[0]?.op, "session.upserted");
  if (deltas[0]?.op !== "session.upserted") return;
  assert.equal(deltas[0].session.pendingInteraction?.interactionId, "q1");
  assert.equal(deltas[0].session.pendingInteractionSummary?.userInputCount, 1);
});

test("a later select still shows after an earlier ask finished", () => {
  const projection = new SessionsIndexProjection("ws", "epoch");
  const deltas = projection.upsertFromConversation(
    {
      sessionId: "s1",
      meta: { title: "问", titleSource: "generated" },
      control: { phase: "running", sessionEnded: false },
      rows: {
        window: [
          {
            kind: "toolCall",
            rowId: 1,
            toolCallId: "c1",
            toolName: "AskUserQuestion",
            status: "success",
            inputText: "",
          },
        ],
      },
      backgroundWorks: [],
      pendingInteractions: [
        {
          interactionId: "select-1",
          kind: "userInput",
          anchorRowId: null,
          createdAt: 2,
          payload: {
            kind: "userInput",
            prompt: "选一个",
            freeText: false,
            options: [{ optionId: "1. A", label: "1. A" }],
            questions: [
              {
                question: "选一个",
                header: "Ask",
                options: [{ value: "1. A", label: "1. A" }],
              },
            ],
          },
        },
      ],
      goal: null,
    } as unknown as ConversationSnapshot,
    extra,
  );
  assert.equal(deltas[0]?.op, "session.upserted");
  if (deltas[0]?.op !== "session.upserted") return;
  assert.equal(deltas[0].session.pendingInteraction?.interactionId, "select-1");
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
