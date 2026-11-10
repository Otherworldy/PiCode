import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionRunPhase } from "@zcode/shared/zcode-protocol-v4";
import { PiToV4Projector } from "./projector.js";

// 空闲时手动 compact：不开新一轮，但侧栏必须显示在跑。
test("an idle compaction marks the session as running for the sidebar", () => {
  const instance = new PiToV4Projector("s1", "e1");
  instance.apply({ type: "agent_start" });
  instance.apply({ type: "agent_end", willRetry: false });
  assert.equal(instance.getSnapshot().control.phase, "completedSuccess");

  instance.apply({ type: "compaction_start" });
  const running = instance.getSnapshot();
  assert.equal(running.control.phase, "completedSuccess");
  assert.deepEqual(
    running.control.activeWorks.map((work) => work.kind),
    ["compact"],
  );
  assert.equal(deriveSessionRunPhase(running), "running");

  instance.apply({ type: "compaction_end", result: { summary: "摘要" } });
  const settled = instance.getSnapshot();
  assert.deepEqual(settled.control.activeWorks, []);
  assert.equal(deriveSessionRunPhase(settled), "completedSuccess");
});

// 回合已经收口、子代理还在跑：侧栏同样要转圈。
test("a live subagent keeps the parent session running after the turn settled", () => {
  const instance = new PiToV4Projector("s1", "e1");
  instance.apply({ type: "agent_start" });
  instance.apply({ type: "agent_end", willRetry: false });

  instance.replaceSubagentWorks([
    {
      workId: "child-1",
      kind: "subagent",
      title: "调研",
      status: "running",
      startedAt: 1,
      cancellable: true,
      anchorRowId: null,
      childSessionId: "child-1",
    },
  ]);
  assert.equal(deriveSessionRunPhase(instance.getSnapshot()), "running");

  instance.replaceSubagentWorks([]);
  assert.equal(deriveSessionRunPhase(instance.getSnapshot()), "completedSuccess");
});
