type TimedRow = {
  rowId: number;
  kind: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
};

/**
 * 思考行经常没有 durationMs。「持续了几秒」会把几十秒的思考说成几秒。
 * 重放时同一条 assistant 消息上的工具和思考共用一个时间戳，思考时长是它和上一条更早事件的间隔。
 * 实时思考的 createdAt 是开始时间，时长要看到下一条更晚的事件。
 */
export function inferReasoningDurations(
  rows: readonly TimedRow[],
  turnStartedAt?: number,
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (const row of rows) {
    if (row.kind !== "reasoning") continue;
    const durationMs = inferOne(rows, row, turnStartedAt);
    if (durationMs !== undefined && durationMs > 0) result.set(row.rowId, durationMs);
  }
  return result;
}

function inferOne(
  rows: readonly TimedRow[],
  row: TimedRow,
  turnStartedAt: number | undefined,
): number | undefined {
  if (row.durationMs !== undefined && row.durationMs > 0) return row.durationMs;
  const at = row.createdAt;
  if (at === undefined) return undefined;

  let previous = turnStartedAt !== undefined && turnStartedAt < at ? turnStartedAt : undefined;
  let sameBatchTool = false;
  let nextStart: number | undefined;
  const index = rows.findIndex((item) => item.rowId === row.rowId);

  for (let i = 0; i < rows.length; i += 1) {
    const other = rows[i];
    if (!other || other.rowId === row.rowId) continue;
    if (other.kind === "toolCall" && other.createdAt === at) sameBatchTool = true;
    const created = other.startedAt ?? other.createdAt;
    if (i > index && created !== undefined && created > at) {
      nextStart = nextStart === undefined ? created : Math.min(nextStart, created);
    }
    const stamps =
      other.kind === "toolCall"
        ? [other.createdAt, other.startedAt, other.endedAt]
        : [other.createdAt];
    for (const stamp of stamps) {
      if (stamp !== undefined && stamp < at && (previous === undefined || stamp > previous)) {
        previous = stamp;
      }
    }
  }

  if (!sameBatchTool && nextStart !== undefined) return nextStart - at;
  if (previous !== undefined) return at - previous;
  return undefined;
}
