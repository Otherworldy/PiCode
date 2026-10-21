import assert from "node:assert/strict";
import test from "node:test";
import type { TurnUsage } from "./rows.js";
import {
  addTurnUsage,
  turnCacheHitRate,
  turnPromptTokens,
  turnTokensPerSecond,
  turnTotalTokens,
} from "./turn-usage.js";

// 真实会话样本（~/.pi/agent/sessions 里的一条 assistant 消息）：
// input 是未缓存输入，与 cacheRead 互不相交。
const real = {
  providerId: "lens",
  modelId: "deepseek-v4.1-flash-free",
  inputTokens: 1505,
  cacheReadTokens: 86016,
  cacheWriteTokens: 0,
  outputTokens: 239,
  llmDurationMs: 5202,
} satisfies TurnUsage;

test("prompt 总量是三桶相加，Pi 的 input 不含 cache", () => {
  assert.equal(turnPromptTokens(real), 87_521);
});

test("总量与 Pi 自己报的 totalTokens 一致", () => {
  // Pi 那条消息的 usage.totalTokens 是 87760，可用来交叉验证口径没有偏。
  assert.equal(turnTotalTokens(real), 87_760);
});

test("缓存命中率落在 0 到 1 之间", () => {
  const rate = turnCacheHitRate(real);
  assert.ok(rate !== null && rate > 0.98 && rate < 0.99, `实际 ${String(rate)}`);
});

test("命中率回归：不能拿 cacheRead 除 input", () => {
  // 旧实现 cacheReadTokens / inputTokens 在这里会算出 17400%。
  const usage = { ...real, inputTokens: 22, cacheReadTokens: 3_840, outputTokens: 19 };
  const rate = turnCacheHitRate(usage);
  assert.ok(rate !== null && rate < 1, `实际 ${String(rate)}`);
  assert.equal(rate, 3_840 / 3_862);
});

test("没有 prompt 侧 token 时命中率是 null，不是 0", () => {
  assert.equal(
    turnCacheHitRate({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      llmDurationMs: 1_000,
    }),
    null,
  );
});

test("吐字速度扣掉首 token 等待", () => {
  // 239 token、总耗时 5202ms、其中 800ms 在等首 token：分母只剩 4402ms。
  const tps = turnTokensPerSecond({ ...real, ttftMs: 800 });
  assert.ok(tps !== null);
  assert.equal(Math.round(tps), 54);
});

test("缺首 token 时刻时退回总时长", () => {
  const tps = turnTokensPerSecond(real);
  assert.ok(tps !== null);
  assert.equal(Math.round(tps), 46);
});

test("首 token 等待超过总时长时不出现负分母", () => {
  const tps = turnTokensPerSecond({ ...real, ttftMs: 9_999 });
  assert.ok(tps !== null);
  assert.equal(Math.round(tps), 46);
});

test("输出为 0 时不给速度，不显示 0 tok/s", () => {
  assert.equal(turnTokensPerSecond({ ...real, outputTokens: 0 }), null);
});

test("缺总时长时不给速度", () => {
  assert.equal(turnTokensPerSecond({ ...real, llmDurationMs: 0 }), null);
  const { llmDurationMs: _dropped, ...withoutDuration } = real;
  assert.equal(turnTokensPerSecond(withoutDuration), null);
});

test("首 token 等待接近总时长时不给出天文数字", () => {
  // 总时长是单调钟、TTFT 是墙钟；时钟漂移会把分母缩到几十毫秒。
  // 分母不足 100ms 就当不可信，退回总时长 —— 46 而不是上千。
  const tps = turnTokensPerSecond({ ...real, ttftMs: 5_180 });
  assert.ok(tps !== null);
  assert.equal(Math.round(tps), 46);
});

test("累加多次调用，提供方与模型取最后一次", () => {
  const second = addTurnUsage(real, {
    providerId: "anthropic",
    modelId: "claude",
    inputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 300,
    outputTokens: 400,
    llmDurationMs: 1_000,
    ttftMs: 200,
  });
  assert.equal(second.inputTokens, 1_605);
  assert.equal(second.cacheReadTokens, 86_216);
  assert.equal(second.cacheWriteTokens, 300);
  assert.equal(second.outputTokens, 639);
  assert.equal(second.llmDurationMs, 6_202);
  assert.equal(second.providerId, "anthropic");
  assert.equal(second.modelId, "claude");
});

test("首 token 时刻只缺一次，合计就不带 ttft，宁可退回总时长", () => {
  const withTtft = addTurnUsage({ ...real, ttftMs: 800 }, { ...real, ttftMs: 400 });
  assert.equal(withTtft.ttftMs, 1_200);

  const mixed = addTurnUsage({ ...real, ttftMs: 800 }, real);
  assert.equal(mixed.ttftMs, undefined);
  // 退回总时长时速度仍然可算，只是分母变大了。
  assert.ok(turnTokensPerSecond(mixed) !== null);
});

test("时长只缺一次，合计也不带时长", () => {
  const { llmDurationMs: _dropped, ...withoutDuration } = real;
  const mixed = addTurnUsage(real, { ...withoutDuration, outputTokens: 10 });
  assert.equal(mixed.llmDurationMs, undefined);
  assert.equal(turnTokensPerSecond(mixed), null);
  // token 数照常累加，只是速度不显示。
  assert.equal(mixed.outputTokens, 249);
});

test("第一次调用直接接住，不做无意义的加法", () => {
  assert.deepEqual(addTurnUsage(undefined, real), real);
});
