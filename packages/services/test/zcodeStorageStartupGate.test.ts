import assert from "node:assert/strict";
import test from "node:test";
import { ZCodeStorageStartupGate } from "../src/zcode-agent/zcodeStorageStartupGate.js";

type Phase = "checking" | "waiting_for_lock" | "migrating" | "committing" | "ready" | "failed";

function state(overrides: { phase?: Phase; sequence?: number } = {}): unknown {
  return {
    schemaVersion: 1,
    attemptId: "attempt-1",
    sequence: overrides.sequence ?? 1,
    databaseId: "db-1",
    databaseKind: "session",
    phase: overrides.phase ?? "migrating",
    elapsedMs: 0,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 首帧到达后原实现会 clearTimeout 且不再装任何定时器：wait() 永久挂起，
// 该 workspace 之后每个 request() 都停在栅栏前，idle 回收也被 isWaiting 挡死。
test("首帧之后不再发帧时，看门狗让 wait() 失败", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 30);
  try {
    assert.equal(gate.accept(state({ phase: "migrating" })), true);
    assert.equal(gate.failed, false);
    await assert.rejects(() => gate.wait(), /startup_status_timeout/);
    assert.equal(gate.failed, true);
  } finally {
    gate.dispose();
  }
});

test("持续收到的状态帧续期看门狗，不误判卡死", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 40);
  try {
    let settled = false;
    const waiting = gate.wait().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // 每 15ms 一帧，总耗时 75ms > 40ms 阈值，但每次都被续期。
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      gate.accept(state({ phase: "migrating", sequence }));
      await sleep(15);
    }
    assert.equal(gate.failed, false, "有进展时不应判失败");
    assert.equal(settled, false, "仍在等待，不该提前结算");

    gate.accept(state({ phase: "ready", sequence: 6 }));
    await waiting;
    assert.equal(settled, true);
  } finally {
    gate.dispose();
  }
});

test("ready 之后看门狗不再触发失败", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 20);
  try {
    gate.accept(state({ phase: "migrating" }));
    gate.accept(state({ phase: "ready", sequence: 2 }));
    await gate.wait();
    await sleep(60);
    assert.equal(gate.failed, false, "已就绪的 gate 不能被看门狗打成失败");
  } finally {
    gate.dispose();
  }
});

test("required=false 时收到帧后仍有看门狗保护", async () => {
  const gate = new ZCodeStorageStartupGate(false, 5_000, 30);
  try {
    assert.equal(gate.accept(state({ phase: "migrating" })), true);
    await assert.rejects(() => gate.wait(), /startup_status_timeout/);
  } finally {
    gate.dispose();
  }
});

test("failed 帧立即结算，并在看门狗到期前保持终态", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 200);
  try {
    gate.accept(state({ phase: "migrating" }));
    gate.accept({ ...(state({ phase: "failed", sequence: 2 }) as object), errorCode: "io_error" });
    await assert.rejects(() => gate.wait(), /io_error/);
    assert.equal(gate.failed, true);
    // 之后的帧不能把失败态改回来。
    assert.equal(gate.accept(state({ phase: "ready", sequence: 3 })), false);
  } finally {
    gate.dispose();
  }
});

test("dispose 后看门狗不再触发", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 30);
  gate.accept(state({ phase: "migrating" }));
  gate.dispose();
  await sleep(60);
  // dispose 会以 transport_closed 结束这次启动，而不是让看门狗再打一次。
  assert.equal(gate.failed, true);
  await assert.rejects(() => gate.wait(), /transport_closed/);
});

// idle 回收靠 publishStorage 在失败通知里读 failed 来决定「继续等」还是「安排回收」。
// Emitter 是同步的，所以 terminalError 必须在 changed.fire() 之前落位 —— 否则监听者
// 读到 failed === false，卡死的进程永远不会被回收。
test("失败通知里读 failed 已经是 true", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 20);
  try {
    let failedInsideListener: boolean | undefined;
    gate.onDidChange((next) => {
      // 只在失败通知里读：accept() 成功时也会 fire，那次的 failed 本来就该是 false。
      if (next.phase === "failed") failedInsideListener ??= gate.failed;
    });
    gate.accept(state({ phase: "migrating" }));
    await sleep(60);
    assert.equal(failedInsideListener, true, "监听器在失败通知里必须看到 failed === true");
  } finally {
    gate.dispose();
  }
});

// required=false 的 gate 从无 pending，dispose() 不会置 terminalError；不挡住迟到帧的话
// 会重新装一个看门狗、让 isWaiting 变回 true，把已放弃的进程重新算成「还在等」。
test("dispose 之后到达的帧不会重新激活 gate", () => {
  const gate = new ZCodeStorageStartupGate(false, 5_000, 20);
  gate.dispose();
  assert.equal(gate.accept(state({ phase: "migrating" })), false);
  assert.equal(gate.failed, false);
  assert.equal(gate.isWaiting, false);
});

// 等锁期间下层有自己的 60 分钟锁预算，而 waiting_for_lock 只上报一次、之后整段零帧。
test("waiting_for_lock 阶段不触发 stall 看门狗", async () => {
  const gate = new ZCodeStorageStartupGate(true, 5_000, 20);
  try {
    gate.accept(state({ phase: "waiting_for_lock" }));
    await sleep(60);
    assert.equal(gate.failed, false, "等锁阶段不能被 180s 量级的看门狗误杀");
  } finally {
    gate.dispose();
  }
});
