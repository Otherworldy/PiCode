import assert from "node:assert/strict";
import test from "node:test";
import { shutdownPiSession, type PiSessionShutdownTarget } from "./session-shutdown.js";

function fakeSession(emit: PiSessionShutdownTarget["extensionRunner"]["emit"]): PiSessionShutdownTarget & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    extensionRunner: {
      hasHandlers: (eventType) => eventType === "session_shutdown",
      emit: (event) => {
        order.push(event.type);
        return emit(event);
      },
    },
    dispose() {
      order.push("dispose");
    },
  };
}

test("shutdown emits session_shutdown before AgentSession.dispose", async () => {
  const session = fakeSession(() => Promise.resolve());
  await shutdownPiSession(session);
  assert.deepEqual(session.order, ["session_shutdown", "dispose"]);
});

test("shutdown still disposes when session_shutdown fails", async () => {
  const session = fakeSession(() => Promise.reject(new Error("mcp close failed")));
  await shutdownPiSession(session);
  assert.deepEqual(session.order, ["session_shutdown", "dispose"]);
});
