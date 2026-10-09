import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  type SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { omitFailedAssistantForContinue, prepareContinueMessages } from "./continue-after-error.js";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai",
    model: "m",
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

function rolesOf(manager: SessionManagerType): string[] {
  return manager.buildSessionProjection().messages.map((message) => message.role);
}

test("continue drops only the failed assistant and keeps the tool result", () => {
  const prepared = prepareContinueMessages([
    { role: "user" },
    { role: "assistant", stopReason: "stop" },
    { role: "toolResult" },
    { role: "assistant", stopReason: "error" },
  ]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(
    prepared.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
});

test("continue refuses a finished assistant reply", () => {
  assert.equal(
    prepareContinueMessages([{ role: "user" }, { role: "assistant", stopReason: "stop" }]).ok,
    false,
  );
  assert.equal(prepareContinueMessages([{ role: "system" }]).ok, false);
});

test("continue drops every trailing failed assistant", () => {
  const prepared = prepareContinueMessages([
    { role: "user" },
    { role: "assistant", stopReason: "error" },
    { role: "assistant", stopReason: "error" },
  ]);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(
    prepared.messages.map((message) => message.role),
    ["user"],
  );
});

test("manual retry omits the failed assistant from the session projection", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  manager.appendMessage(assistant("stop"));
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 1,
  });
  manager.appendMessage(assistant("error", "503"));
  let replaced: string[] | undefined;
  const prepared = omitFailedAssistantForContinue({
    sessionManager: manager,
    replaceMessages: (messages) => {
      replaced = messages.map((message) => message.role);
    },
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(rolesOf(manager), ["user", "assistant", "toolResult"]);
  assert.deepEqual(replaced, ["user", "assistant", "toolResult"]);
});

test("manual retry refuses to continue a finished assistant", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  manager.appendMessage(assistant("stop"));
  const prepared = omitFailedAssistantForContinue({
    sessionManager: manager,
    replaceMessages: () => {
      throw new Error("finished reply must stay");
    },
  });
  assert.equal(prepared.ok, false);
  assert.deepEqual(rolesOf(manager), ["user", "assistant"]);
});
