import assert from "node:assert/strict";
import test from "node:test";
import { createProgressWatchdog } from "./progressWatchdog.js";

function collector() {
  const reasons: Array<"first_frame" | "stall"> = [];
  return { reasons, onTimeout: (reason: "first_frame" | "stall") => reasons.push(reason) };
}

test("首帧之前超时上报 first_frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    onTimeout: sink.onTimeout,
  });
  t.mock.timers.tick(29);
  assert.deepEqual(sink.reasons, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sink.reasons, ["first_frame"]);
  watchdog.dispose();
});

test("首帧到达后清掉首帧超时，改由 stall 计时", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    onTimeout: sink.onTimeout,
  });
  t.mock.timers.tick(10);
  watchdog.noteFrame("migrating");
  // 已经过了首帧超时的时点，但首帧定时器应已被清掉。
  t.mock.timers.tick(25);
  assert.deepEqual(sink.reasons, []);
  watchdog.dispose();
});

test("每个状态帧续期 stall，不误判卡死", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    onTimeout: sink.onTimeout,
  });
  watchdog.noteFrame("migrating");
  for (let index = 0; index < 5; index += 1) {
    t.mock.timers.tick(90);
    watchdog.noteFrame("migrating");
  }
  assert.deepEqual(sink.reasons, [], "总时长 450 > 100，但每 90 都续期");

  t.mock.timers.tick(101);
  assert.deepEqual(sink.reasons, ["stall"]);
  watchdog.dispose();
});

test("pausesStall 的阶段不触发 stall", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    pausesStall: (phase) => phase === "waiting_for_lock",
    onTimeout: sink.onTimeout,
  });

  // 等锁期间下层有自己的 60 分钟锁预算，看门狗必须完全停下。
  watchdog.noteFrame("waiting_for_lock");
  t.mock.timers.tick(100_000);
  assert.deepEqual(sink.reasons, []);

  // 离开等锁阶段后恢复计时。
  watchdog.noteFrame("migrating");
  t.mock.timers.tick(101);
  assert.deepEqual(sink.reasons, ["stall"]);
  watchdog.dispose();
});

test("dispose 之后不再触发，且 noteFrame 是 no-op", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    onTimeout: sink.onTimeout,
  });
  watchdog.noteFrame("migrating");
  watchdog.dispose();
  watchdog.noteFrame("migrating");
  t.mock.timers.tick(100_000);
  assert.deepEqual(sink.reasons, []);
});

test("终态帧之后仍会再计时一次（调用方负责 dispose）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sink = collector();
  const watchdog = createProgressWatchdog({
    firstFrameTimeoutMs: 30,
    stallTimeoutMs: 100,
    onTimeout: sink.onTimeout,
  });
  watchdog.noteFrame("ready");
  t.mock.timers.tick(101);
  // 端口的「ready 之后不再触发」由调用方在 exit/终态处 dispose 保证；
  // 这里记录看门狗自身的契约，避免调用方漏掉 dispose 时误以为它自己会停。
  assert.deepEqual(sink.reasons, ["stall"]);
  watchdog.dispose();
});
