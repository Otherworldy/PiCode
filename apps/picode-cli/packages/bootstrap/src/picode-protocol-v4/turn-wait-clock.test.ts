import assert from "node:assert/strict";
import test from "node:test";
import {
  beginWait,
  closedWaitedMsIn,
  cloneTurnWaitClock,
  createTurnWaitClock,
  endWait,
  resetWaitClock,
  waitedMsForTurn,
  waitedMsIn,
} from "./turn-wait-clock.js";

test("一段等待按区间记，整轮求和", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  endWait(clock, 4_000, "perm:c1");
  assert.equal(waitedMsIn(clock, 0, 10_000), 3_000);
  assert.equal(waitedMsForTurn(clock, 10_000), 3_000);
});

test("并发等待合并成一段，后到的请求不截断先到的那段", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  beginWait(clock, 2_000, "perm:c2");
  // 先到的那段还在等，后到的不重设起点，区间也没关闭。
  endWait(clock, 3_000, "perm:c1");
  assert.equal(clock.openStartedAtMs, 1_000);
  assert.deepEqual(clock.spans, []);
  // 部分收口：已结束的为 0；含进行中那段的话从最早的起点算到当前，2s。
  // 协议上的 waitedMs 用前者，waitingSince 单独表达后者，两边都含 open 段会被扣两次。
  assert.equal(closedWaitedMsIn(clock, 0, 3_000), 0);
  assert.equal(waitedMsIn(clock, 0, 3_000), 2_000);
  // 最后一个收口，区间从最早的起点算到它结束。
  endWait(clock, 5_000, "perm:c2");
  assert.equal(waitedMsIn(clock, 0, 10_000), 4_000);
});

test("没登记过的键收口不会凭空造出区段", () => {
  const clock = createTurnWaitClock();
  endWait(clock, 5_000, "perm:c1");
  assert.deepEqual(clock.spans, []);
  assert.equal(clock.openStartedAtMs, null);
});

test("hook 审核被更高 generation 替换：旧键收口不开新段，新区间接着算", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "hook:r1");
  // 替换发生在同一时刻：先收旧键再登新键，中间不留 0 长度空档。
  endWait(clock, 2_000, "hook:r1");
  beginWait(clock, 2_000, "hook:r2");
  endWait(clock, 4_000, "hook:r2");
  assert.equal(waitedMsIn(clock, 0, 10_000), 3_000);
});

test("裁剪到工作段区间：段外的等待不算进这一段", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  endWait(clock, 3_000, "perm:c1");
  beginWait(clock, 6_000, "perm:c2");
  endWait(clock, 8_000, "perm:c2");
  // 只有 6s-8s 落在第二段里。
  assert.equal(waitedMsIn(clock, 5_000, 10_000), 2_000);
  // 跨两段的区间两段都算。
  assert.equal(waitedMsIn(clock, 0, 10_000), 4_000);
  // 段起点落在等待中间时只算重叠部分。
  assert.equal(waitedMsIn(clock, 2_000, 10_000), 1_000 + 2_000);
});

test("进行中的那段算到当前时刻，运行中也能扣", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 5_000, "perm:c1");
  assert.equal(waitedMsIn(clock, 0, 9_000), 4_000);
  assert.equal(clock.openStartedAtMs, 5_000);
});

test("新轮清空等待，跨轮等待不算这一轮工时", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  endWait(clock, 3_000, "perm:c1");
  beginWait(clock, 4_000, "perm:c2");
  resetWaitClock(clock);
  assert.deepEqual(clock.spans, []);
  assert.equal(clock.openStartedAtMs, null);
  assert.equal(clock.openKeys.size, 0);
  assert.equal(waitedMsIn(clock, 0, 10_000), 0);
});

test("事件时间戳回退产生重叠时合并，不重复扣同一段时间", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  endWait(clock, 5_000, "perm:c1");
  // 冷恢复合成事件可能把下一段起点报得更早；与末段重叠要合并，不能相加。
  beginWait(clock, 3_000, "perm:c2");
  endWait(clock, 7_000, "perm:c2");
  assert.deepEqual(clock.spans, [{ startMs: 1_000, endMs: 7_000 }]);
  assert.equal(waitedMsIn(clock, 0, 10_000), 6_000);
});

test("克隆出的候选投影带自己的等待账本，互不影响", () => {
  const clock = createTurnWaitClock();
  beginWait(clock, 1_000, "perm:c1");
  const copy = cloneTurnWaitClock(clock);
  endWait(copy, 3_000, "perm:c1");
  assert.equal(waitedMsIn(copy, 0, 10_000), 2_000);
  // 原时钟还在等，没有被克隆的收口影响。
  assert.equal(clock.openStartedAtMs, 1_000);
  assert.deepEqual(clock.spans, []);
});
