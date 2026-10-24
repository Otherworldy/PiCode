import { HostResponseTypes } from "@zcode/shared";
import { setNetworkTelemetrySink, type NetworkObservation } from "@zcode/rpc";

interface HostNetworkTelemetryParentPort {
  postMessage(message: unknown): void;
}

const pending: NetworkObservation[] = [];
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_MAX_BATCH = 200;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeParentPort: HostNetworkTelemetryParentPort | null = null;

function flushHostNetworkTelemetryBatch(): void {
  if (!activeParentPort || pending.length === 0) {
    return;
  }
  const observations = pending.splice(0, FLUSH_MAX_BATCH);
  try {
    activeParentPort.postMessage({
      type: HostResponseTypes.NetworkTelemetryBatch,
      observations,
    });
  } catch {
    // 遥测批次失败不应影响 host 主流程
  }
}

export function registerHostNetworkTelemetry(
  parentPort: HostNetworkTelemetryParentPort | null | undefined,
): void {
  // 重复注册只应有一个 flush 循环；先收掉上一轮的 interval，否则每次注册叠加一个。
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // 修复原因：desktop host 是 Electron utility process，通信端口在 process.parentPort；
  // node:worker_threads.parentPort 在这里为 null，会导致 LLM/RPC 网络遥测批次无法发回 main。
  activeParentPort = parentPort ?? null;
  if (!activeParentPort) {
    // 没有出口时入队就是纯泄漏：flushHostNetworkTelemetryBatch 在没有 parent 时直接
    // return，连 splice 都不做，pending 会随每条 RPC 网络观察一直长下去。
    pending.length = 0;
    setNetworkTelemetrySink(null);
    return;
  }
  setNetworkTelemetrySink((observation) => {
    if (!activeParentPort) return;
    pending.push(observation);
    if (pending.length >= FLUSH_MAX_BATCH) {
      flushHostNetworkTelemetryBatch();
    }
  });

  flushTimer = setInterval(flushHostNetworkTelemetryBatch, FLUSH_INTERVAL_MS);
}

export function stopHostNetworkTelemetry(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  setNetworkTelemetrySink(null);
  flushHostNetworkTelemetryBatch();
  // flush 只发一批（FLUSH_MAX_BATCH），剩下的在这里丢掉：进程复用后重新 register 时
  // 旧会话的观察不该混进新批次。
  pending.length = 0;
  activeParentPort = null;
}
