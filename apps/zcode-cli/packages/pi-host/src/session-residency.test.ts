import assert from "node:assert/strict";
import test from "node:test";
import { piHostBlocksResidency } from "./command-bridge.js";

const idlePi = { isStreaming: false, isCompacting: false, isIdle: true };

test("a settled projection still blocks residency while Pi is streaming", () => {
  assert.equal(
    piHostBlocksResidency({
      pi: { isStreaming: true, isIdle: true },
      phase: "completedSuccess",
    }),
    true,
  );
});

test("compaction and a not-yet-idle turn block residency without a running phase", () => {
  assert.equal(
    piHostBlocksResidency({
      pi: { isStreaming: false, isCompacting: true, isIdle: true },
      phase: "completedSuccess",
    }),
    true,
  );
  assert.equal(
    piHostBlocksResidency({
      pi: { isStreaming: false, isIdle: false },
      phase: "completedSuccess",
    }),
    true,
  );
});

test("queue, background work, subagents, branch summary, and pending interactions block residency", () => {
  assert.equal(piHostBlocksResidency({ pi: idlePi, queuedCount: 1 }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, backgroundActive: true }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, runningSubagents: 1 }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, branchSummary: true }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, pendingInteraction: true }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, activeWorkCount: 1 }), true);
  assert.equal(piHostBlocksResidency({ pi: idlePi, phase: "running" }), true);
});

test("a fully idle session can leave the resident pool", () => {
  assert.equal(
    piHostBlocksResidency({
      pi: idlePi,
      phase: "completedSuccess",
      activeWorkCount: 0,
      queuedCount: 0,
      branchSummary: false,
      backgroundActive: false,
      pendingInteraction: false,
      runningSubagents: 0,
    }),
    false,
  );
});
