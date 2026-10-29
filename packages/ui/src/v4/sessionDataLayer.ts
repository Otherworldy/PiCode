// SessionDataLayer（纯数据层）。
// Map<topic, SessionStore>，不知道「显示」这回事；生命周期 = 引用计数：
// 有 pane 引用 → 订阅；归零 → 进入空闲队列延迟退订（keep-warm，防拖拽/切 pane 抖动）。
// 一个实例对应一条 host 连接；跨 workspace 分屏在 shell 层做
// Map<workspaceKey, SessionDataLayer>，本层不感知 workspace。
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";

/** 会话租约命中状态：cold = 新订阅，warm = 引用未断，keep_warm = 空闲池保活命中。 */
type SessionLeaseOpenKind = "cold" | "warm" | "keep_warm";

/** pane 持有的租约；release 幂等。 */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /** 由数据层按 projection 生命周期判定，避免 pane 首次 render 时 snapshot 仍为空。 */
  readonly openKind: SessionLeaseOpenKind;
  /** pane acquire 的 Renderer 单调时钟起点。 */
  readonly startedAt: number;
  release(): void;
}

interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** 引用归零后的空闲上限（ms），默认 30 分钟。 */
  keepWarmMs?: number;
}

// 常驻策略与 CLI session 常驻池同标度（session-resident-pool.ts：target 16 / high water 32 /
// idle 30min）。之前是「引用归零 30 秒就退订」，用户切到别的会话或别的视图超过 30 秒再回来
// 就被判成冷订阅、重新走一次「加载会话」；最近看过的会话应该按使用而不是按秒数保活。
const SESSION_DATA_LAYER_IDLE_TARGET_COUNT = 16;
const SESSION_DATA_LAYER_IDLE_HIGH_WATER_COUNT = 32;
const SESSION_DATA_LAYER_KEEP_WARM_MS = 30 * 60_000;
// E2E 需要一个确定的冷路径：把空闲上限压到 1 秒，时间一到就退订。
const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;

function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SessionDataLayer {
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  /** 引用归零的 topic，最久未用在队首。长度即空闲投影数，不参与 entries 之外的另存。 */
  private readonly idleTopics: string[] = [];
  private readonly offFrame: () => void;
  private disposed = false;

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    // 连接级单监听：按 topic 扇入到各 store（pane 间共享的正是这一条连接）。
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
  }

  /**
   * 取得 session 的投影 store。首个引用触发 subscribe（新开 pane 就是一次
   * subscribe，与刷新、新设备同一路径）；重复 acquire 共享同一 store（readonly，
   * 同 session 多 pane = 多视图）。
   */
  acquire(sessionId: string): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer 已释放，不能再 acquire");
    }
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();
    let entry = this.entries.get(topic);
    let openKind: SessionLeaseOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
      this.removeIdle(topic);
    } else {
      const store = new ConversationProjectionStore(topic, this.transport);
      entry = { store, refCount: 1, keepWarmTimer: null };
      this.entries.set(topic, entry);
      openKind = "cold";
      // 订阅失败落在 store.state（status=error + retry()），不在这里抛。
      void store.connect({ rendererPrepareStartedAt: startedAt });
    }
    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      // 不能现读 entry.keepWarmTimer：命中分支在上面已经把它清成 null 了。
      keepWarm: openKind === "keep_warm",
      module: "ui.v4.session_data_layer",
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(topic);
      },
    };
  }

  /** 当前活跃（含 keep-warm 中）的 session 数，测试与调试观测点。 */
  get size(): number {
    return this.entries.size;
  }

  /** renderer pending-command registry 的只读对账入口；仍复用本 layer 的同一 host connection。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // 关 pane ≠ 停 session：这里只是退订视图，session 在 CLI 里照跑。
    entry.keepWarmTimer = setTimeout(() => {
      this.evictIdle(topic, "idle_timeout");
    }, this.keepWarmMs);
    this.idleTopics.push(topic);
    this.reclaimIdleOverflow();
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      idleCount: this.idleTopics.length,
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  private removeIdle(topic: string): void {
    const index = this.idleTopics.indexOf(topic);
    if (index !== -1) this.idleTopics.splice(index, 1);
  }

  /** 空闲队列超过 high water 时按最久未用收到目标容量，留出回摆空间，避免来回点就反复冷恢复。 */
  private reclaimIdleOverflow(): void {
    if (this.idleTopics.length <= SESSION_DATA_LAYER_IDLE_HIGH_WATER_COUNT) return;
    while (this.idleTopics.length > SESSION_DATA_LAYER_IDLE_TARGET_COUNT) {
      const oldest = this.idleTopics.shift();
      if (oldest === undefined) break;
      this.evictIdle(oldest, "idle_overflow");
    }
  }

  private evictIdle(topic: string, reason: "idle_timeout" | "idle_overflow"): void {
    const entry = this.entries.get(topic);
    if (!entry || entry.refCount > 0) return;
    this.removeIdle(topic);
    this.entries.delete(topic);
    if (entry.keepWarmTimer !== null) {
      clearTimeout(entry.keepWarmTimer);
      entry.keepWarmTimer = null;
    }
    logger.lifecycle.info("v4 session data keep-warm expired", {
      event: "v4.session_data.keep_warm_expired",
      idleCount: this.idleTopics.length,
      module: "ui.v4.session_data_layer",
      reason,
      refCount: 0,
      status: "completed",
      topic,
    });
    void entry.store.close();
  }

  /** 连接销毁时清场（window/workspace 卸载）。 */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.offFrame();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    this.idleTopics.length = 0;
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
