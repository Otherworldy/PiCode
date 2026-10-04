import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";

export type LiveSubagentModel = {
  provider: string;
  model: string;
  thought: string;
};

type LiveSubagent = {
  abort: () => void;
  getModel: () => LiveSubagentModel;
  setModel: (next: LiveSubagentModel) => Promise<boolean>;
};

// ponytail: 进程内一张表。子会话都活在这个 agent 进程里；拆成多进程再按宿主分表。
const running = new Map<string, LiveSubagent>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function trackLiveSubagent(id: string, live: LiveSubagent): () => void {
  if (!id) return () => undefined;
  running.set(id, live);
  notify();
  return () => {
    if (running.get(id) !== live) return;
    running.delete(id);
    notify();
  };
}

export function subscribeLiveSubagents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasLiveSubagent(id: string): boolean {
  return running.has(id);
}

export function getLiveSubagentModel(id: string): LiveSubagentModel | undefined {
  const model = running.get(id)?.getModel();
  if (!model?.provider || !model.model) return undefined;
  return model;
}

/** 只改这一次运行。调用方负责不写设置、不停父会话。 */
export async function setLiveSubagentModel(id: string, next: LiveSubagentModel): Promise<boolean> {
  const live = running.get(id);
  if (!live) return false;
  const ok = await live.setModel(next);
  if (ok) notify();
  return ok;
}

/** 只停这个子会话。父会话的 stop 不走这里。 */
export function abortLiveSubagent(id: string): boolean {
  const live = running.get(id);
  if (!live) return false;
  live.abort();
  return true;
}

/**
 * 状态面板的 Stop 只认 backgroundWorks。目录行没有对应的活会话时不给按钮，
 * 避免点了停不掉、或停到别的任务。
 */
export function subagentControlWorks(
  children: readonly { childSessionId: string; title: string; startedAt?: number }[],
  isLive: (id: string) => boolean,
): BackgroundWorkSummary[] {
  const works: BackgroundWorkSummary[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    if (!child.childSessionId || seen.has(child.childSessionId) || !isLive(child.childSessionId)) {
      continue;
    }
    seen.add(child.childSessionId);
    works.push({
      workId: child.childSessionId,
      kind: "subagent",
      title: child.title || child.childSessionId,
      status: "running",
      startedAt: child.startedAt ?? 0,
      cancellable: true,
      anchorRowId: null,
      childSessionId: child.childSessionId,
    });
  }
  return works;
}
