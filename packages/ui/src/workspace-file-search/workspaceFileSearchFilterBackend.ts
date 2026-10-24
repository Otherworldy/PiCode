import type { WorkspaceFileEntry } from "@zcode/shared";
import { logger } from "@/logger.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";

/**
 * 工作区文件搜索过滤后端抽象：候选打分+top-K 排序的执行位置。
 *
 * 背景：放开 node_modules 等目录后候选基数
 * 可达数十万，主线程同步打分每键 50-300ms 会阻塞输入——打分已移入 Web Worker。
 * 数据搬运同样不能走结构化克隆：37 万 entries 的 postMessage 克隆实测 ~471ms
 * 主线程同步阻塞（打开 @ 面板整窗冻结数秒的主因之一），因此 worker 传输改用
 * 列式打包字符串（实测 ~31ms），worker 内解码构建候选。
 *
 * 同步实现保留两个用途：(1) Worker 不可用/运行失败的降级路径，行为与历史版本一致；
 * (2) 单测环境（Node 下无 Web Worker）注入。
 */
export interface WorkspaceFileSearchFilterBackend {
  /** 全量候选更新（列式 packed 字符串 + rootPath 用于拼回 name/path）；调用后既有 filter 结果作废。 */
  setPacked(packed: string, rootPath: string): void;
  /**
   * 按 query 过滤并返回有序 entry 列表（已映射回原始对象，≤limit 条）。
   * Promise 永不 reject：过期结果（setEntries 或更新的 filter 之后）解析为 null，
   * 调用方据此丢弃。
   */
  filter(
    query: string,
    options: FilterWorkspaceFileSearchCandidatesOptions,
  ): Promise<WorkspaceFileEntry[] | null>;
  dispose(): void;
}

function createSyncWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
  let byId: Map<string, WorkspaceFileEntry> = new Map();
  return {
    setPacked(packed, rootPath) {
      const entries = unpackWorkspaceFileEntries(packed, rootPath);
      candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
      byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    },
    filter(query, options) {
      return Promise.resolve(
        filterWorkspaceFileSearchCandidates(candidates, query, options)
          .map((candidate) => byId.get(candidate.id) ?? null)
          .filter((entry): entry is WorkspaceFileEntry => entry !== null),
      );
    },
    dispose() {
      candidates = [];
      byId = new Map();
    },
  };
}

export function createWorkerWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  // Node 测试环境（vitest node project）没有 module worker 运行时，直接走同步路径；
  // jsdom 等有 document 但 Worker 未实现的环境由下方 try/catch 兜底降级。
  if (typeof document === "undefined") {
    return createSyncWorkspaceFileSearchFilterBackend();
  }
  let worker: Worker | null;
  try {
    worker = new Worker(new URL("./workspaceFileSearchFilter.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-workspace-file-search",
    });
  } catch (error) {
    // 降级路径：非常老的事件循环/测试环境不支持 module worker 时回退同步打分。
    logger.warn("[workspace-file-search] Worker 创建失败，回退主线程同步过滤", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createSyncWorkspaceFileSearchFilterBackend();
  }

  let seq = 0;
  const pending = new Map<number, { resolve: (entries: WorkspaceFileEntry[] | null) => void }>();
  // 最近一次 setPacked 的入参：降级时必须重放，否则 filter 会在空候选上返回 []。
  let packedState: { packed: string; rootPath: string } | null = null;
  // 终态之后唯一实现。worker 的未捕获异常已经终止了它本身，同实例内重建会立刻再崩，
  // 所以不重试；hook 卸载后新实例会重新尝试 worker。
  let fallback: WorkspaceFileSearchFilterBackend | null = null;
  let disposed = false;

  const settleAllAsStale = (): void => {
    for (const [, waiter] of pending) {
      waiter.resolve(null);
    }
    pending.clear();
  };

  /**
   * 修复原因：onerror 原来只让在途请求过期，注释以为「后续 filter 仍会重试」。但 Worker
   * 未捕获异常后自身已经终止，之后的 postMessage 是静默 no-op——后续每个 filter 的 Promise
   * 永不 settle，pending 随输入无限增长，@ 面板永久 loading 且搜索静默失效。
   */
  const degrade = (reason: string): WorkspaceFileSearchFilterBackend => {
    if (fallback) return fallback;
    const dead = worker;
    worker = null;
    dead?.terminate();
    logger.warn("[workspace-file-search] Worker 已终止，切换到主线程同步过滤", { reason });
    const sync = createSyncWorkspaceFileSearchFilterBackend();
    if (packedState) sync.setPacked(packedState.packed, packedState.rootPath);
    fallback = sync;
    return sync;
  };

  const bootWorker = worker;

  bootWorker.onmessage = (
    event: MessageEvent<{ type: string; seq?: number; entries?: WorkspaceFileEntry[] }>,
  ) => {
    const data = event.data;
    if (data.type !== "result" || typeof data.seq !== "number") {
      return;
    }
    const waiter = pending.get(data.seq);
    if (!waiter) {
      return;
    }
    pending.delete(data.seq);
    waiter.resolve(Array.isArray(data.entries) ? data.entries : null);
  };

  bootWorker.onerror = (event) => {
    settleAllAsStale();
    if (disposed) return;
    degrade(event.message || "worker error");
  };

  return {
    setPacked(packed, rootPath) {
      packedState = { packed, rootPath };
      seq += 1;
      settleAllAsStale();
      if (fallback) {
        fallback.setPacked(packed, rootPath);
        return;
      }
      // packed 由 Host 侧 listWorkspaceFiles 直接产出（RPC 返回字符串，memcpy 级传输），
      // renderer 全程不构建 entries 对象——37 万条实测省去 11-14s 结构化克隆。
      worker?.postMessage({ type: "entries", packed, rootPath });
    },
    filter(query, options) {
      if (fallback) return fallback.filter(query, options);
      const live = disposed ? null : worker;
      if (!live) return Promise.resolve(null);
      seq += 1;
      const currentSeq = seq;
      return new Promise<WorkspaceFileEntry[] | null>((resolve) => {
        pending.set(currentSeq, { resolve });
        live.postMessage({
          type: "filter",
          seq: currentSeq,
          query,
          options,
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      seq += 1;
      settleAllAsStale();
      const dead = worker;
      worker = null;
      dead?.terminate();
      fallback?.dispose();
      fallback = null;
      packedState = null;
    },
  };
}
