import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";

// 打开中的 pane 才有 conversation snapshot。侧栏 sessions-index 会晚一拍，
// 运行图标以这里的 phase 为准；pane 卸掉后删掉，列表回到 index。
type LivePhase = SessionSummary["phase"];

const phases = new Map<string, LivePhase>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSessionLivePhase(sessionId: string, phase: LivePhase | null): void {
  const current = phases.get(sessionId) ?? null;
  if (current === phase) return;
  if (phase == null) phases.delete(sessionId);
  else phases.set(sessionId, phase);
  emit();
}

export function subscribeSessionLivePhase(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getSessionLivePhase(sessionId: string): LivePhase | null {
  return phases.get(sessionId) ?? null;
}
