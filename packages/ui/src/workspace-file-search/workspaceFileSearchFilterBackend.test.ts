import type { WorkspaceFileEntry } from "@zcode/shared";
import { packWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "@/logger.js";
import { createWorkerWorkspaceFileSearchFilterBackend } from "./workspaceFileSearchFilterBackend.js";

/**
 * Worker 运行期崩溃后的降级契约。
 *
 * 原实现 onerror 只让在途请求过期，注释假设「后续 filter 仍会重试」；但 Worker 未捕获
 * 异常后自身已终止，之后的 postMessage 是静默 no-op，于是后续 filter 的 Promise 永不
 * settle、pending 随输入无界增长。这里锁住「崩溃即降级」的行为。
 */

type WorkerMessage = Record<string, unknown>;

class FakeWorker {
  static latest: FakeWorker | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: WorkerMessage[] = [];
  terminated = false;

  constructor(_url: URL, _options?: unknown) {
    FakeWorker.latest = this;
  }

  postMessage(message: WorkerMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message = "worker boom"): void {
    this.onerror?.({ message });
  }

  reply(seq: number, entries: WorkspaceFileEntry[] | null): void {
    this.onmessage?.({ data: { type: "result", seq, entries } });
  }
}

const ENTRIES: WorkspaceFileEntry[] = [
  { name: "apple.ts", path: "/ws/src/apple.ts", relativePath: "src/apple.ts", type: "file" },
  { name: "banana.ts", path: "/ws/src/banana.ts", relativePath: "src/banana.ts", type: "file" },
  { name: "src", path: "/ws/src", relativePath: "src", type: "directory" },
];
const PACKED = packWorkspaceFileEntries(ENTRIES);
const ROOT = "/ws";

function currentWorker(): FakeWorker {
  const worker = FakeWorker.latest;
  if (!worker) throw new Error("worker 未被创建");
  return worker;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeWorker.latest = null;
  // backend 在 typeof document === "undefined" 时直接返回同步实现，测不到 worker 路径。
  vi.stubGlobal("document", {});
  vi.stubGlobal("Worker", FakeWorker);
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("Worker 崩溃后的降级", () => {
  test("崩溃时在途 filter 解析为 null 而不是永久挂住", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);

    const inFlight = backend.filter("apple", {});
    currentWorker().crash();

    await expect(inFlight).resolves.toBeNull();
  });

  test("崩溃后 filter 走同步实现并返回正确结果", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);
    currentWorker().crash();

    const result = await backend.filter("apple", {});

    expect(result?.map((entry) => entry.relativePath)).toEqual(["src/apple.ts"]);
  });

  test("崩溃时 terminate 死 worker，之后 postMessage 不再发往它", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);
    const worker = currentWorker();
    worker.crash();
    const postedBefore = worker.posted.length;

    backend.setPacked(PACKED, ROOT);
    await backend.filter("apple", {});

    expect(worker.terminated).toBe(true);
    expect(worker.posted.length).toBe(postedBefore);
  });

  test("未 setPacked 就崩溃：降级实现返回空数组，不抛错", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    currentWorker().crash();

    await expect(backend.filter("apple", {})).resolves.toEqual([]);
  });

  test("崩溃后新的 setPacked 会重放给降级实现", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);
    currentWorker().crash();

    const onlyBanana = packWorkspaceFileEntries([ENTRIES[1]!]);
    backend.setPacked(onlyBanana, ROOT);

    const result = await backend.filter("banana", {});
    expect(result?.map((entry) => entry.relativePath)).toEqual(["src/banana.ts"]);
    await expect(backend.filter("apple", {})).resolves.toEqual([]);
  });

  test("降级时记录一条 warn，说明已切到主线程同步过滤", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    currentWorker().crash("boom");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("切换到主线程同步过滤"),
      expect.objectContaining({ reason: "boom" }),
    );
    backend.dispose();
  });

  test("dispose 幂等，之后调用 filter 不抛且解析为 null", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);

    backend.dispose();
    backend.dispose();
    await expect(backend.filter("apple", {})).resolves.toBeNull();
  });

  test("dispose 之后到达的 onerror 不创建降级实现", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    const worker = currentWorker();
    backend.dispose();
    worker.crash();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("Worker 正常路径不受影响", () => {
  test("worker 回包时把结果交给等待者", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);

    const inFlight = backend.filter("apple", {});
    const request = currentWorker().posted.at(-1);
    expect(request?.type).toBe("filter");

    currentWorker().reply(request?.seq as number, [ENTRIES[0]!]);

    await expect(inFlight).resolves.toEqual([ENTRIES[0]]);
  });

  test("setPacked 让在途 filter 作废，并推送新候选", async () => {
    const backend = createWorkerWorkspaceFileSearchFilterBackend();
    backend.setPacked(PACKED, ROOT);
    const inFlight = backend.filter("apple", {});
    backend.setPacked(PACKED, ROOT);

    await expect(inFlight).resolves.toBeNull();

    currentWorker().reply(1_000, [ENTRIES[0]!]);
    expect(currentWorker().terminated).toBe(false);
  });
});
