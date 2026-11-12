import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionResidentPool,
  type SessionResidentPoolHost,
  type SessionResidencyFacts,
} from "./session-resident-pool.js";

function createHost(sessionIds: readonly string[]): SessionResidentPoolHost & { size: () => number } {
  const resident = new Set(sessionIds);
  const facts = (sessionId: string): SessionResidencyFacts | null =>
    resident.has(sessionId)
      ? {
          persisted: true,
          hasResidencyBlockingWork: false,
          hasPendingInteractions: false,
          hasQueuedCommands: false,
          hasSubscribers: false,
          hasLegacySubscriber: false,
          lastActivityAt: 0,
        }
      : null;
  return {
    listSessionIds: () => [...resident],
    readResidencyFacts: facts,
    deactivate: (sessionId) => {
      resident.delete(sessionId);
      return Promise.resolve();
    },
    size: () => resident.size,
  };
}

function sessionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `session-${index}`);
}

test("seventeen idle sessions stay resident under the relaxed high water", () => {
  const host = createHost(sessionIds(17));
  new SessionResidentPool(host, { now: () => 0 }).rebalance();
  assert.equal(host.size(), 17);
});

test("the thirty-third idle session is trimmed back to sixteen", () => {
  const host = createHost(sessionIds(33));
  new SessionResidentPool(host, { now: () => 0 }).rebalance();
  assert.equal(host.size(), 16);
});

test("an idle session survives just under thirty minutes and leaves at the timeout", () => {
  let now = 0;
  const host = createHost(["session-0"]);
  const pool = new SessionResidentPool(host, { now: () => now });
  pool.rebalance();
  now = 30 * 60 * 1_000 - 1;
  pool.rebalance();
  assert.equal(host.size(), 1);
  now = 30 * 60 * 1_000;
  pool.rebalance();
  assert.equal(host.size(), 0);
});
