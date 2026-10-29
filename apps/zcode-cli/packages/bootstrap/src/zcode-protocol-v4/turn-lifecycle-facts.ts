import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  turnLifecycleFactSchema,
  type TurnLifecycleFact,
} from "@zcode/shared/zcode-protocol-v4";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventTimestamp(event: SessionEvent): number {
  const value =
    event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function terminalStatus(resultType: unknown): "success" | "interrupted" | "failed" {
  const normalized = optionalString(resultType);
  switch (normalized) {
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "error":
    case "failed":
      return "failed";
    default:
      return "success";
  }
}

/**
 * 把本进程 live SessionEvent 中的轮次起止归一成 `turn.started` / `turn.terminal` 事实。
 *
 * 这不是埋点：`zcode-server-cli` supervisor 用它统计运行中会话数，据此阻止带任务的
 * 更新与卸载。事实只带归属与终态，不带 prompt、工具输入或 provider 地址；也不读取
 * transcript/snapshot，因此无法在 hydration/recovery 时补造事件。
 */
export class TurnLifecycleFactNormalizer {
  normalize(sessionId: string, event: SessionEvent): TurnLifecycleFact | null {
    const turnId = event.turnId ? String(event.turnId) : undefined;
    const base = {
      version: 1 as const,
      eventId: String(event.id),
      eventSeq: Math.max(0, Math.floor(event.sequenceNumber)),
      occurredAt: eventTimestamp(event),
      sessionId,
      ...(turnId ? { turnId } : {}),
    };

    switch (event.type) {
      case SessionEventType.TurnStarted:
        return turnLifecycleFactSchema.parse({ ...base, kind: "turn.started" });
      case SessionEventType.TurnComplete:
        return turnLifecycleFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          status: terminalStatus((event.payload as { resultType?: unknown }).resultType),
        });
      case SessionEventType.TurnError:
        return turnLifecycleFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          status: "failed",
        });
      default:
        return null;
    }
  }
}
