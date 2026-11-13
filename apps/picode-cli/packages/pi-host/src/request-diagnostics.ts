import { randomUUID } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { getPiSdkStatus } from "./pi-sdk.js";

interface ContextMeasurement {
  contextImageCount: number;
  contextImageBase64Bytes: number;
  contextMeasurementMs: number;
}

type Correlation = "session_request" | "missing_context" | "cache_warming" | "overlapping";
type Outcome = "completed" | "error" | "aborted" | "shutdown" | "superseded" | "unattributed";

export interface RequestDiagnostic extends Partial<ContextMeasurement> {
  phase: "prepared" | "settled";
  observerId: string;
  sessionId: string;
  parentSessionId?: string;
  requestIndex: number;
  sdkSource: "builtin" | "global";
  sdkVersion: string;
  selectedProvider?: string;
  selectedModel?: string;
  provider?: string;
  model?: string;
  api?: string;
  modelSource: "selection" | "provider_event";
  configuredTransport?: string;
  correlation: Correlation;
  logLevel?: "debug" | "info";
  payloadJsonBytes?: number;
  payloadMeasurement: "measured" | "unserializable";
  payloadMeasurementMs: number;
  responseStatus?: number;
  responseHeadersMs?: number;
  firstProviderEventMs?: number;
  firstContentMs?: number;
  firstTextMs?: number;
  durationMs?: number;
  outcome?: Outcome;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const LARGE_REQUEST_BYTES = 1024 * 1024;

export function requestDiagnosticLogLevel(diagnostic: RequestDiagnostic): "debug" | "info" {
  return diagnostic.logLevel === "info" ||
    (diagnostic.contextImageCount ?? 0) > 0 ||
    (diagnostic.payloadJsonBytes ?? 0) >= LARGE_REQUEST_BYTES
    ? "info"
    : "debug";
}

export function createRequestDiagnosticsExtension(options: {
  parentSessionId?: string;
  onDiagnostic?: (diagnostic: RequestDiagnostic) => void;
  configuredTransport?: () => string;
  now?: () => number;
}): InlineExtension {
  // 生命周期内只保留数值摘要，不保存 payload、正文或第二份会话历史。
  const observerId = randomUUID();
  let requestIndex = 0;
  const now = options.now ?? (() => performance.now());
  return {
    name: "picode-request-diagnostics",
    hidden: true,
    factory(pi) {
      let context: ContextMeasurement | undefined;
      let active: { summary: RequestDiagnostic; started: number } | undefined;
      let uncertain: "cache_warming" | "overlapping" | undefined;
      const publish = (diagnostic: RequestDiagnostic) => {
        try {
          options.onDiagnostic?.({ ...diagnostic });
        } catch {
          // 日志只观察，不让诊断回调故障改变模型请求。
        }
      };
      const finish = (outcome: Outcome) => {
        if (!active) return;
        const { summary, started } = active;
        active = undefined;
        const correlated = summary.correlation === "session_request";
        publish({
          ...summary,
          phase: "settled",
          outcome: correlated || outcome === "shutdown" ? outcome : "unattributed",
          ...(correlated && outcome !== "superseded" && outcome !== "unattributed"
            ? { durationMs: now() - started }
            : {}),
        });
      };
      const markUncertain = (reason: "cache_warming" | "overlapping") => {
        uncertain = reason;
        if (!active) return;
        active.summary.correlation = reason;
        delete active.summary.contextImageCount;
        delete active.summary.contextImageBase64Bytes;
        delete active.summary.contextMeasurementMs;
        delete active.summary.responseStatus;
        delete active.summary.responseHeadersMs;
        delete active.summary.firstProviderEventMs;
        delete active.summary.firstContentMs;
        delete active.summary.firstTextMs;
        // Hook 没有 request ID；已出现交叠后，本扩展生命周期内不再猜测响应归属。
        delete active.summary.provider;
        delete active.summary.model;
        delete active.summary.api;
        active.summary.modelSource = "selection";
      };
      pi.on("context_with_system", (event) => {
        const started = now();
        let contextImageCount = 0,
          contextImageBase64Bytes = 0;
        for (const message of event.messages) {
          if (!("content" in message) || !Array.isArray(message.content)) continue;
          for (const block of message.content) {
            if (block.type !== "image") continue;
            contextImageCount++;
            contextImageBase64Bytes += Buffer.byteLength(block.data, "utf8");
          }
        }
        context = {
          contextImageCount,
          contextImageBase64Bytes,
          contextMeasurementMs: now() - started,
        };
      });
      pi.on("cache_warming_decision", (event) => {
        if (event.action !== "stop") markUncertain("cache_warming");
      });
      pi.on("before_provider_request", (event, ctx) => {
        if (active) {
          markUncertain(uncertain ?? "overlapping");
          finish("superseded");
        }
        const started = now();
        let payloadJsonBytes: number | undefined;
        try {
          const serialized = JSON.stringify(event.payload);
          if (serialized !== undefined) payloadJsonBytes = Buffer.byteLength(serialized, "utf8");
        } catch {
          // 计量失败仍交回原 payload；由原 provider 链路决定是否可发送。
        }
        const sdk = getPiSdkStatus();
        const summary: RequestDiagnostic = {
          phase: "prepared",
          observerId,
          sessionId: ctx.sessionManager.getSessionId(),
          parentSessionId: options.parentSessionId,
          requestIndex: ++requestIndex,
          sdkSource: sdk.active,
          sdkVersion:
            sdk.active === "global"
              ? (sdk.globalVersion ?? sdk.builtinVersion)
              : sdk.builtinVersion,
          selectedProvider: ctx.model?.provider,
          selectedModel: ctx.model?.id,
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          api: ctx.model?.api,
          modelSource: "selection",
          configuredTransport: options.configuredTransport?.(),
          correlation: uncertain ?? (context ? "session_request" : "missing_context"),
          ...(uncertain ? {} : context),
          payloadJsonBytes,
          payloadMeasurement: payloadJsonBytes === undefined ? "unserializable" : "measured",
          payloadMeasurementMs: now() - started,
        };
        summary.logLevel = requestDiagnosticLogLevel(summary);
        context = undefined;
        active = { summary, started };
        publish(summary);
      });
      pi.on("after_provider_response", (event) => {
        if (!active || active.summary.correlation !== "session_request") return;
        active.summary.responseStatus ??= event.status;
        active.summary.responseHeadersMs ??= now() - active.started;
      });
      pi.on("provider_stream_event", (event) => {
        if (!active || active.summary.correlation !== "session_request") return;
        Object.assign(active.summary, {
          provider: event.provider,
          model: event.model,
          api: event.api,
          modelSource: "provider_event",
        });
        active.summary.firstProviderEventMs ??= now() - active.started;
      });
      pi.on("message_update", (event) => {
        if (
          !active ||
          active.summary.correlation !== "session_request" ||
          event.message.role !== "assistant"
        )
          return;
        const delta = event.assistantMessageEvent;
        const hasDelta =
          (delta.type === "text_delta" ||
            delta.type === "thinking_delta" ||
            delta.type === "toolcall_delta") &&
          Boolean(delta.delta);
        const tool =
          delta.type === "toolcall_start" ||
          delta.type === "toolcall_delta" ||
          delta.type === "toolcall_end"
            ? delta.partial.content[delta.contentIndex]
            : undefined;
        // 工具名称/ID 已是输出；不能等参数 delta，空参数工具可能没有该增量。
        if (!hasDelta && !(tool?.type === "toolCall" && (tool.name || tool.id))) return;
        active.summary.firstContentMs ??= now() - active.started;
        if (delta.type === "text_delta") active.summary.firstTextMs ??= now() - active.started;
      });
      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        // delegate 也会结束 assistant 消息；无 payload 时不能把上下文留给后续请求。
        context = undefined;
        if (active?.summary.correlation === "session_request" && event.message.usage) {
          const usage = event.message.usage;
          // 通用日志会脱敏含 token 的键；数值用量沿 SDK 结构记录，避免落盘变成 [Redacted]。
          active.summary.usage = {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          };
        }
        finish(
          event.message.stopReason === "error"
            ? "error"
            : event.message.stopReason === "aborted"
              ? "aborted"
              : "completed",
        );
      });
      pi.on("agent_end", () => {
        finish("unattributed");
        context = undefined;
      });
      pi.on("session_shutdown", () => {
        finish("shutdown");
        context = undefined;
      });
    },
  };
}
