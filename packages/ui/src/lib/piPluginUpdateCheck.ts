export const PI_PLUGIN_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type PiPluginUpdateSnapshot<T extends { id: string } = { id: string }> = {
  workspaceKey: string;
  updates: readonly T[];
  checkedAt?: number;
};

export function piPluginUpdateWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 检查时间在未来或已经满 24 小时，都当成需要再查。 */
export function piPluginUpdateCacheIsFresh(
  checkedAt: number | undefined,
  now: number,
  interval = PI_PLUGIN_UPDATE_CHECK_INTERVAL_MS,
): boolean {
  return (
    typeof checkedAt === "number" &&
    Number.isFinite(checkedAt) &&
    now >= checkedAt &&
    now - checkedAt < interval
  );
}

export function piPluginUpdateCheckDelay(
  checkedAt: number | undefined,
  now: number,
  interval = PI_PLUGIN_UPDATE_CHECK_INTERVAL_MS,
): number {
  if (checkedAt === undefined || !piPluginUpdateCacheIsFresh(checkedAt, now, interval)) return 0;
  return interval - (now - checkedAt);
}

/** 后到的更旧快照不能盖掉刚检查完的结果。换工作区则整份换掉。 */
export function applyPiPluginUpdateSnapshot<T extends { id: string }>(
  current: PiPluginUpdateSnapshot<T>,
  next: PiPluginUpdateSnapshot<T>,
): PiPluginUpdateSnapshot<T> {
  if (current.workspaceKey === next.workspaceKey && current.checkedAt !== undefined) {
    if (next.checkedAt === undefined || next.checkedAt < current.checkedAt) return current;
  }
  return next;
}
