import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTransport } from "@/v4/transport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";

// 日志在测试里只制造噪音：这一层每个 acquire/release 都会打一条 lifecycle。
(
  globalThis as typeof globalThis & { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;

/** 只覆盖本层用到的路径：订阅不回 ACK（投影停在 connecting），退订是空操作。 */
function createTransport() {
  const subscribe = vi.fn(() => new Promise<never>(() => {}));
  const transport = {
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    subscribe,
    unsubscribe: async () => {},
  } as unknown as ConversationTransport;
  return { transport, subscribe };
}

function createLayer(keepWarmMs = 60_000) {
  const { transport, subscribe } = createTransport();
  return { layer: new SessionDataLayer({ transport, keepWarmMs }), subscribe };
}

describe("SessionDataLayer 常驻投影", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("引用归零后仍复用同一份投影，切回来不重新订阅", () => {
    const { layer, subscribe } = createLayer();
    const first = layer.acquire("s1");
    const firstStore = first.store;
    first.release();

    const again = layer.acquire("s1");

    expect(again.openKind).toBe("keep_warm");
    expect(again.store).toBe(firstStore);
    expect(subscribe).toHaveBeenCalledTimes(1);
    again.release();
  });

  it("空闲上限到期才退订，重新打开回到冷订阅", async () => {
    const { layer } = createLayer(5_000);
    const lease = layer.acquire("s1");
    const closeSpy = vi.spyOn(lease.store, "close");
    lease.release();
    expect(closeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(layer.size).toBe(0);
    expect(layer.acquire("s1").openKind).toBe("cold");
  });

  it("空闲投影超过 high water 才按最久未用收到目标容量", () => {
    const { layer } = createLayer();
    const leases = Array.from({ length: 32 }, (_, index) => layer.acquire(`s${index}`));
    for (const lease of leases) lease.release();
    // 刚刚等于 high water 时不回收，全部留着。
    expect(layer.size).toBe(32);

    const overflow = layer.acquire("s-extra");
    overflow.release();
    // 越过 high water 后一次收到目标容量，留下最近使用的那些。
    expect(layer.size).toBe(16);
    expect(layer.acquire("s0").openKind).toBe("cold");
    expect(layer.acquire("s31").openKind).toBe("keep_warm");
    expect(layer.acquire("s-extra").openKind).toBe("keep_warm");
  });

  it("重新引用的空闲投影回到队列尾部，再次溢出时不会被当成最久未用淘汰", () => {
    const { layer } = createLayer();
    const leases = Array.from({ length: 32 }, (_, index) => layer.acquire(`s${index}`));
    for (const lease of leases) lease.release();

    // s0 是最久未用的，但用户点回来了：它必须重新算「最近使用」，而不是留在队首。
    const revived = layer.acquire("s0");
    expect(revived.openKind).toBe("keep_warm");
    const revivedStore = revived.store;
    revived.release();

    // 再打开一条把空闲队列顶过 high water（32）。
    layer.acquire("s-extra-1").release();
    expect(layer.size).toBe(16);

    // 真按「最近使用」算：s0 留着，最久未用的 s1 被收掉。
    const reopened = layer.acquire("s0");
    expect(reopened.store).toBe(revivedStore);
    expect(reopened.openKind).toBe("keep_warm");
    expect(layer.acquire("s1").openKind).toBe("cold");
  });

  it("dispose 后空闲投影清场，挂起的空闲定时器不再触发", async () => {
    const { layer } = createLayer(5_000);
    const lease = layer.acquire("s1");
    const closeSpy = vi.spyOn(lease.store, "close");
    lease.release();

    layer.dispose();
    expect(layer.size).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
