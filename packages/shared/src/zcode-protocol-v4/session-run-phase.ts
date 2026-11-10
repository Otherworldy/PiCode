import type { ActiveWorkSummary, BackgroundWorkSummary, SessionPhase } from "./snapshot.js";

type RunningWorkSnapshot = {
  control: {
    phase: SessionPhase;
    activeWorks?: readonly Pick<ActiveWorkSummary, "kind">[];
  };
  backgroundWorks?: readonly Pick<BackgroundWorkSummary, "kind" | "status">[];
};

/**
 * 列表相位：compact 与子代理进行中时，`control.phase` 可能已是终态 ——
 * 空闲压缩不新开一轮，后台子代理在回合结束后继续跑。侧栏转圈和桌面 liveStatus
 * 都只读 phase，所以把这两类进行中的工作折算成 running。
 *
 * 只用于列表/状态展示的派生，不回写会话内 `control.phase`：
 * canStop、队列推进和输入可用性仍按真实相位判定。
 */
export function hasRunningCompactWork(
  activeWorks: readonly Pick<ActiveWorkSummary, "kind">[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact");
}

export function hasRunningSubagentWork(
  backgroundWorks: readonly Pick<BackgroundWorkSummary, "kind" | "status">[],
): boolean {
  return backgroundWorks.some((work) => work.kind === "subagent" && work.status === "running");
}

export function deriveSessionRunPhase(snapshot: RunningWorkSnapshot): SessionPhase {
  const phase = snapshot.control.phase;
  // 回合自己就在跑（含自动 compact、前台子代理），无需折算。
  if (phase === "running" || phase === "prewarming" || phase === "draft") return phase;
  // 失败点比转圈更重要；失败会话上不会同时挂着 compact 或子代理。
  if (phase === "error") return phase;
  const busy =
    hasRunningCompactWork(snapshot.control.activeWorks ?? []) ||
    hasRunningSubagentWork(snapshot.backgroundWorks ?? []);
  return busy ? "running" : phase;
}
