import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionRunPhase } from "./session-run-phase.js";

const idle = { activeWorks: [], backgroundWorks: [] };

test("a finished turn stays finished when nothing runs", () => {
  assert.equal(
    deriveSessionRunPhase({ control: { phase: "completedSuccess", ...idle } }),
    "completedSuccess",
  );
});

test("an idle compact keeps the list spinning", () => {
  assert.equal(
    deriveSessionRunPhase({
      control: { phase: "completedSuccess", activeWorks: [{ kind: "compact" }] },
      backgroundWorks: [],
    }),
    "running",
  );
});

test("a running subagent keeps the list spinning", () => {
  assert.equal(
    deriveSessionRunPhase({
      control: { phase: "completedSuccess", activeWorks: [] },
      backgroundWorks: [{ kind: "subagent", status: "running" }],
    }),
    "running",
  );
});

test("background bash and settled subagents do not spin", () => {
  assert.equal(
    deriveSessionRunPhase({
      control: { phase: "completedSuccess", activeWorks: [] },
      backgroundWorks: [
        { kind: "bash", status: "running" },
        { kind: "subagent", status: "resultPending" },
      ],
    }),
    "completedSuccess",
  );
});

test("a real running phase is not overwritten", () => {
  assert.equal(deriveSessionRunPhase({ control: { phase: "running", ...idle } }), "running");
});

test("a failed session keeps its error dot", () => {
  assert.equal(
    deriveSessionRunPhase({
      control: { phase: "error", activeWorks: [{ kind: "compact" }] },
      backgroundWorks: [],
    }),
    "error",
  );
});

test("draft never spins", () => {
  assert.equal(
    deriveSessionRunPhase({
      control: { phase: "draft", activeWorks: [{ kind: "compact" }] },
      backgroundWorks: [],
    }),
    "draft",
  );
});
