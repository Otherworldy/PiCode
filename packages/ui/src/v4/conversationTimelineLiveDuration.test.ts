import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, test } from "vitest";
import { applyLiveWorkDuration } from "@/v4/conversationTimelineLiveDuration.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

/**
 * 时间线的 1 Hz 时钟只能影响正在跑的那一轮。
 *
 * 原实现把 `liveNowMs` 放进 `buildConversationTurnRenderUnits` 的依赖，每秒重建全部
 * render unit，`memo(ConversationTurnGroup)` 随之全部失效，长会话每秒重渲染整部历史。
 */

const STARTED_AT = 1_000;

function completedTurnRows(): ConversationRow[] {
  const header: TurnHeaderRow = {
    rowId: 1,
    turnId: "t1",
    createdAt: STARTED_AT,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 4_000,
    activeMs: 4_000,
  };
  return [
    header,
    {
      rowId: 2,
      turnId: "t1",
      createdAt: STARTED_AT + 1_000,
      createdAtSeq: 2,
      kind: "assistantText",
      text: "done",
      state: "complete",
    },
  ];
}

function runningTurnRows(overrides: Partial<TurnHeaderRow> = {}): ConversationRow[] {
  const header: TurnHeaderRow = {
    rowId: 3,
    turnId: "t2",
    createdAt: STARTED_AT,
    createdAtSeq: 3,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "running",
    startedAt: STARTED_AT,
    ...overrides,
  };
  return [header];
}

function buildUnits(): ReturnType<typeof buildConversationTurnRenderUnits> {
  return buildConversationTurnRenderUnits([...completedTurnRows(), ...runningTurnRows()], {
    sessionPhase: "running",
  });
}

/** 生产路径只对 live tail 补时长，不逐帧扫描历史。 */
function applyFrame(
  units: ReturnType<typeof buildConversationTurnRenderUnits>,
  nowMs: number,
): ReturnType<typeof buildConversationTurnRenderUnits> {
  const liveIndex = units.findLastIndex((unit) => unit.isRunning);
  return liveIndex < 0
    ? units
    : units.map((unit, index) => (index === liveIndex ? applyLiveWorkDuration(unit, nowMs) : unit));
}

describe("applyLiveWorkDuration", () => {
  test("只有最后一轮在跑", () => {
    const units = buildUnits();
    expect(units).toHaveLength(2);
    expect(units[0]?.isRunning).toBe(false);
    expect(units[1]?.isRunning).toBe(true);
  });

  test("已完成的轮次无论时钟怎么走都返回同一个引用", () => {
    const units = buildUnits();
    const completed = units[0]!;

    expect(applyLiveWorkDuration(completed, 10_000)).toBe(completed);
    expect(applyLiveWorkDuration(completed, 11_000)).toBe(completed);
    expect(applyLiveWorkDuration(completed, 999_000)).toBe(completed);
  });

  test("运行中的轮次按 nowMs 推进净工时", () => {
    const running = buildUnits()[1]!;

    const after5s = applyLiveWorkDuration(running, STARTED_AT + 5_000);
    const after6s = applyLiveWorkDuration(running, STARTED_AT + 6_000);

    expect(after5s.workStatus?.durationMs).toBe(5_000);
    expect(after6s.workStatus?.durationMs).toBe(6_000);
    expect(after5s).not.toBe(after6s);
  });

  test("同一个 nowMs 重复调用保持引用，不制造无意义重建", () => {
    const running = buildUnits()[1]!;

    const first = applyLiveWorkDuration(running, STARTED_AT + 5_000);
    const repeat = applyLiveWorkDuration(first, STARTED_AT + 5_000);

    expect(repeat).toBe(first);
  });

  test("没有 workStatus 的轮次原样返回，不凭空造出状态行", () => {
    // controlOnly 轮的 workStatus 由 resolveConversationTurnWorkStatus 主动丢弃；
    // 这里补工时会把本来不该出现的状态行画出来。
    const withoutStatus = { ...buildUnits()[1]!, workStatus: undefined };

    expect(applyLiveWorkDuration(withoutStatus, 10_000)).toBe(withoutStatus);
  });

  test("整帧推进时历史 unit 引用不变，只有 running 的换", () => {
    const units = buildUnits();

    const frameOne = applyFrame(units, STARTED_AT + 5_000);
    const frameTwo = applyFrame(units, STARTED_AT + 6_000);

    // 这两个断言就是 memo(ConversationTurnGroup) 的命中条件。
    expect(frameOne[0]).toBe(frameTwo[0]);
    expect(frameOne[1]).not.toBe(frameTwo[1]);
  });

  test("已带 activeMs 的轮次不吃时钟：不同 nowMs 返回同一引用", () => {
    // resolveConversationTurnWorkDurationMs 在 activeMs 在场时直接返回它，
    // 这类轮次每秒补时长只会白造对象。
    const [unit] = buildConversationTurnRenderUnits(
      runningTurnRows({ activeMs: 3_000 }),
      { sessionPhase: "running" },
    );

    const first = applyLiveWorkDuration(unit!, STARTED_AT + 5_000);
    expect(applyLiveWorkDuration(first, STARTED_AT + 6_000)).toBe(first);
    expect(first.workStatus?.durationMs).toBe(3_000);
  });

  test("已带 endedAt 的轮次同样不吃时钟", () => {
    const [unit] = buildConversationTurnRenderUnits(
      runningTurnRows({ endedAt: STARTED_AT + 2_500 }),
      { sessionPhase: "running" },
    );

    const first = applyLiveWorkDuration(unit!, STARTED_AT + 5_000);
    expect(applyLiveWorkDuration(first, STARTED_AT + 6_000)).toBe(first);
    expect(first.workStatus?.durationMs).toBe(2_500);
  });

  test("等待中（waitingSince）的净工时冻结，不产生新引用", () => {
    // 净工时 = nowMs - startedAt - (nowMs - waitingSince) = waitingSince - startedAt，
    // 与时钟无关；这正是「审批和提问不算干活」的表达。
    const [unit] = buildConversationTurnRenderUnits(
      runningTurnRows({ waitingSince: STARTED_AT + 1_000 }),
      { sessionPhase: "running" },
    );

    const first = applyLiveWorkDuration(unit!, STARTED_AT + 5_000);
    const later = applyLiveWorkDuration(first, STARTED_AT + 60_000);

    expect(first.workStatus?.durationMs).toBe(1_000);
    expect(later).toBe(first);
  });
});

describe("builder 本身不看时钟", () => {
  test("builder 的 nowMs 只影响运行中轮次的工时", () => {
    const rows = [...completedTurnRows(), ...runningTurnRows()];

    const first = buildConversationTurnRenderUnits(rows, { nowMs: 5_000, sessionPhase: "running" });
    const second = buildConversationTurnRenderUnits(rows, {
      nowMs: 6_000,
      sessionPhase: "running",
    });

    // 完成态由 endedAt/activeMs 决定，不吃 nowMs；运行中才逐秒推进。
    expect(first[0]?.workStatus?.durationMs).toBe(4_000);
    expect(second[0]?.workStatus?.durationMs).toBe(4_000);
    expect(first[1]?.workStatus?.durationMs).toBe(4_000);
    expect(second[1]?.workStatus?.durationMs).toBe(5_000);
  });

  test("不带 nowMs 时历史 unit 的引用同样不复用，但顶层不再触发重建", () => {
    const rows = [...completedTurnRows(), ...runningTurnRows()];

    const first = buildConversationTurnRenderUnits(rows, { sessionPhase: "running" });
    const second = buildConversationTurnRenderUnits(rows, { sessionPhase: "running" });

    // builder 是无状态纯函数，同样的输入本来就会产出新对象；稳定性由顶层的 useMemo
    // 依赖（不含时钟）保证，而不是靠 builder 内部缓存。
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.workStatus?.durationMs).toBe(second[0]?.workStatus?.durationMs);
  });
});
