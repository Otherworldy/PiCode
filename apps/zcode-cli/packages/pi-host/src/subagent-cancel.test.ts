import assert from "node:assert/strict";
import test from "node:test";
import {
  abortLiveSubagent,
  getLiveSubagentModel,
  hasLiveSubagent,
  setLiveSubagentModel,
  subagentControlWorks,
  trackLiveSubagent,
} from "./live-subagents.js";
import { PiToV4Projector } from "./projector.js";

test("cancel aborts only the tracked subagent", async () => {
  const stopped: string[] = [];
  let model = { provider: "acme", model: "small", thought: "low" };
  const release = trackLiveSubagent("child-1", {
    abort: () => stopped.push("child-1"),
    getModel: () => model,
    setModel: async (next) => {
      model = next;
      return true;
    },
  });
  assert.equal(hasLiveSubagent("child-1"), true);
  assert.equal(abortLiveSubagent("missing"), false);
  assert.equal(
    await setLiveSubagentModel("child-1", { provider: "acme", model: "large", thought: "high" }),
    true,
  );
  assert.deepEqual(getLiveSubagentModel("child-1"), {
    provider: "acme",
    model: "large",
    thought: "high",
  });
  assert.equal(abortLiveSubagent("child-1"), true);
  assert.deepEqual(stopped, ["child-1"]);
  release();
  assert.equal(hasLiveSubagent("child-1"), false);
  assert.equal(abortLiveSubagent("child-1"), false);
});

test("stop control is only the live child, and bash works stay put", () => {
  const works = subagentControlWorks(
    [
      { childSessionId: "live", title: "scout", startedAt: 5 },
      { childSessionId: "dead", title: "old", startedAt: 1 },
      { childSessionId: "live", title: "duplicate", startedAt: 9 },
    ],
    (id) => id === "live",
  );
  assert.equal(works.length, 1);
  assert.equal(works[0]?.workId, "live");
  assert.equal(works[0]?.kind, "subagent");
  assert.equal(works[0]?.cancellable, true);
  assert.equal(works[0]?.childSessionId, "live");

  const projector = new PiToV4Projector("s1", "e1");
  projector.replaceManagedProcesses([
    {
      workId: "pi-process:proc_1",
      kind: "bash",
      title: "sleep",
      status: "running",
      startedAt: 1,
      cancellable: true,
      anchorRowId: null,
    },
  ]);
  projector.replaceSubagentWorks(works);
  assert.deepEqual(
    projector.getSnapshot().backgroundWorks.map((work) => work.workId),
    ["pi-process:proc_1", "live"],
  );
  projector.replaceSubagentWorks([]);
  assert.deepEqual(
    projector.getSnapshot().backgroundWorks.map((work) => work.workId),
    ["pi-process:proc_1"],
  );
  assert.equal(projector.replaceSubagentWorks([]).length, 0);
  projector.replaceManagedProcesses([]);
  assert.deepEqual(projector.getSnapshot().backgroundWorks, []);
});
