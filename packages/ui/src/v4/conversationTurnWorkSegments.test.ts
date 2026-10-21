import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveWorkChunkStatusFacts,
} from "./conversationTurnWorkSegments.js";

function header(overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    rowId: 1,
    turnId: "t1",
    createdAt: 1_000,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "running",
    startedAt: 1_000,
    ...overrides,
  };
}

function toolRow(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: 1_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "echo hi",
  };
}

test("完成态直接用 CLI 算好的 activeMs，不再二次扣等待", () => {
  assert.equal(
    resolveConversationTurnWorkDurationMs(
      header({ state: "completedSuccess", endedAt: 11_000, activeMs: 4_000, waitedMs: 6_000 }),
      { nowMs: 99_000 },
      false,
    ),
    4_000,
  );
});

test("运行中扣掉已结束的等待", () => {
  assert.equal(
    resolveConversationTurnWorkDurationMs(header({ waitedMs: 3_000 }), { nowMs: 10_000 }, true),
    6_000,
  );
});

test("运行中正在等待时秒数不走", () => {
  // 1s 开轮，8s 起被审批卡住：10s 时只认 1s 到 8s 这 7s。
  assert.equal(
    resolveConversationTurnWorkDurationMs(header({ waitingSince: 8_000 }), { nowMs: 10_000 }, true),
    7_000,
  );
});

test("已结束的等待和进行中的那段同时扣", () => {
  // 墙钟 9s，已结束的等待 2s，5s 起又卡住（到 10s 是 5s）。工时只剩 2s。
  assert.equal(
    resolveConversationTurnWorkDurationMs(
      header({ waitedMs: 2_000, waitingSince: 5_000 }),
      { nowMs: 10_000 },
      true,
    ),
    2_000,
  );
});

test("等待比墙钟还长时钳到 0，不出现负数工时", () => {
  // 开轮就被审核卡住：整轮没在干活。
  assert.equal(
    resolveConversationTurnWorkDurationMs(header({ waitingSince: 1_000 }), { nowMs: 10_000 }, true),
    0,
  );
  assert.equal(
    resolveConversationTurnWorkDurationMs(header({ waitedMs: 99_000 }), { nowMs: 10_000 }, true),
    0,
  );
});

test("缺 activeMs 时回退的墙钟也要扣等待", () => {
  // 审批中被打断：1s 开轮，10s 结束，其中 6s 在等用户点按钮。
  assert.equal(
    resolveConversationTurnWorkDurationMs(
      header({ state: "completedInterrupted", endedAt: 10_000, waitedMs: 6_000 }),
      { nowMs: 99_000 },
      false,
    ),
    3_000,
  );
});

test("历史完成态缺 activeMs 时不吃当前时钟", () => {
  assert.equal(
    resolveConversationTurnWorkDurationMs(
      header({ state: "completedSuccess" }),
      { nowMs: 99_000 },
      false,
    ),
    undefined,
  );
});

test("分段时长与整轮同口径：段内等待也要扣", () => {
  const segments = buildConversationTurnWorkSegments({
    key: "t1",
    header: header({
      workSegments: [
        {
          segmentId: "s1",
          startedAt: 1_000,
          waitedMs: 3_000,
          waitingSince: 8_000,
        },
      ],
    }),
    orderedRows: [toolRow(2)],
    assistantTailRows: [],
    isRunning: true,
    isLastTurn: true,
    isInterrupted: false,
    timelineOnly: false,
    nowMs: 10_000,
  });

  assert.equal(segments[0]?.workStatus?.durationMs, 4_000);
});

test("已完成的第一块只报自己的跨度，不顶着整轮工时一直走秒", () => {
  // 截图的场景：整轮跑到 14 分 6 秒，第一块只调用过一次工具并且早就结束了。
  assert.deepEqual(
    resolveWorkChunkStatusFacts({
      segmentState: "running",
      segmentDurationMs: 846_000,
      isWorkingChunk: false,
      isTailChunk: false,
      toolCount: 1,
      chunkDurationMs: 400,
    }),
    { running: false, interrupted: false, durationMs: 400, toolCount: 1 },
  );
});

test("运行态文案与整轮净工时只挂在当前工作块上", () => {
  assert.deepEqual(
    resolveWorkChunkStatusFacts({
      segmentState: "running",
      segmentDurationMs: 846_000,
      isWorkingChunk: true,
      isTailChunk: true,
      toolCount: 2,
      chunkDurationMs: 3_000,
    }),
    { running: true, interrupted: false, durationMs: 846_000, toolCount: 2 },
  );
});

test("段没在跑时即使被标成当前块也不显示运行态", () => {
  const facts = resolveWorkChunkStatusFacts({
    segmentState: "completed",
    segmentDurationMs: 846_000,
    isWorkingChunk: true,
    isTailChunk: true,
    toolCount: 2,
    chunkDurationMs: 3_000,
  });

  assert.equal(facts.running, false);
  assert.equal(facts.durationMs, 3_000);
});

test("中断文案只挂在本段最后一块，前面的块照常报自己的耗时", () => {
  assert.deepEqual(
    resolveWorkChunkStatusFacts({
      segmentState: "interrupted",
      segmentDurationMs: 9_000,
      isWorkingChunk: false,
      isTailChunk: true,
      toolCount: 3,
    }),
    { running: false, interrupted: true, toolCount: 0 },
  );
  assert.deepEqual(
    resolveWorkChunkStatusFacts({
      segmentState: "interrupted",
      segmentDurationMs: 9_000,
      isWorkingChunk: false,
      isTailChunk: false,
      toolCount: 3,
      chunkDurationMs: 2_000,
    }),
    { running: false, interrupted: false, durationMs: 2_000, toolCount: 3 },
  );
});

test("没有可折叠块的状态行只报整轮时长", () => {
  assert.deepEqual(
    resolveWorkChunkStatusFacts({
      segmentState: "completed",
      segmentDurationMs: 12_000,
      isWorkingChunk: false,
      isTailChunk: true,
      toolCount: 4,
      chunkDurationMs: 2_000,
      plain: true,
    }),
    { running: false, interrupted: false, durationMs: 12_000, toolCount: 0 },
  );
});
