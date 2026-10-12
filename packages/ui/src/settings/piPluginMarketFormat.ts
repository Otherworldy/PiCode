export function pageNumbers(current: number, count: number): number[] {
  const start = Math.max(1, Math.min(current - 2, count - 4));
  const end = Math.min(count, start + 4);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function relativeTime(value: string | undefined): string {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const delta = Math.max(0, Date.now() - time);
  const hour = 3_600_000;
  const day = 86_400_000;
  if (delta < hour) return `${Math.max(1, Math.round(delta / 60_000))}m`;
  if (delta < day) return `${Math.round(delta / hour)}h`;
  if (delta < 30 * day) return `${Math.round(delta / day)}d`;
  if (delta < 365 * day) return `${Math.round(delta / (30 * day))}mo`;
  return `${Math.round(delta / (365 * day))}y`;
}
