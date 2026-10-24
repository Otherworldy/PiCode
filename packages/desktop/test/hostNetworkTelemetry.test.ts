import assert from "node:assert/strict";
import test from "node:test";
import {
  registerHostNetworkTelemetry,
  stopHostNetworkTelemetry,
} from "../src/host/hostNetworkTelemetry.js";

/**
 * 只观察 timer 的创建/清理，不依赖模块私有状态。
 *
 * 原来的 registerHostNetworkTelemetry 无论有没有 parentPort 都挂 sink 和 interval：
 * 没有 parent 时 flush 直接 return 且不 splice，pending 随每条 RPC 网络观察无界增长。
 */
function withIntervalSpy(run: () => void): { created: number; cleared: number } {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const counts = { created: 0, cleared: 0 };
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    counts.created += 1;
    return realSetInterval(callback, ms);
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: NodeJS.Timeout) => {
    counts.cleared += 1;
    realClearInterval(handle);
  }) as typeof clearInterval;
  try {
    run();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
  return counts;
}

test("没有 parentPort 时不挂 flush 定时器", () => {
  const counts = withIntervalSpy(() => registerHostNetworkTelemetry(null));

  assert.deepEqual(counts, { created: 0, cleared: 0 });
  stopHostNetworkTelemetry();
});

test("parentPort 是 undefined 时同样不挂定时器", () => {
  const counts = withIntervalSpy(() => registerHostNetworkTelemetry(undefined));

  assert.deepEqual(counts, { created: 0, cleared: 0 });
  stopHostNetworkTelemetry();
});

test("重复注册只保留一个 flush 循环", () => {
  const port = { postMessage: () => {} };
  const counts = withIntervalSpy(() => {
    registerHostNetworkTelemetry(port);
    registerHostNetworkTelemetry(port);
  });

  // 两次创建、一次清理 —— 净存活一个 interval。
  assert.equal(counts.created, 2);
  assert.equal(counts.cleared, 1);
  stopHostNetworkTelemetry();
});

test("先无 port 后有 port：只有一个定时器", () => {
  const counts = withIntervalSpy(() => {
    registerHostNetworkTelemetry(null);
    registerHostNetworkTelemetry({ postMessage: () => {} });
  });

  assert.equal(counts.created, 1);
  assert.equal(counts.cleared, 0);
  stopHostNetworkTelemetry();
});
