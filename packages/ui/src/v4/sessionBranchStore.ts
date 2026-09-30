import { useSyncExternalStore } from "react";
import type { SessionTreeNodeView } from "@zcode/shared/zcode-protocol-v4";

export type SessionBranchActions = {
  sessionId: string;
  nodes: SessionTreeNodeView[];
  busy: boolean;
  refresh: () => void;
  switchTo: (entryId: string) => void;
  rename: (entryId: string, label: string) => void;
  remove: (entryId: string) => void;
};

let current: SessionBranchActions | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSessionBranchActions(next: SessionBranchActions | null): void {
  current = next;
  emit();
}

export function clearSessionBranchActions(expected: SessionBranchActions): void {
  if (current !== expected) return;
  current = null;
  emit();
}

export function useSessionBranchActions(sessionId: string | null | undefined): SessionBranchActions | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
  if (!sessionId || value?.sessionId !== sessionId) return null;
  return value;
}
