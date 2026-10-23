import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

/** drain 的低水位：低于它就认为写队列已经排空。 */
const WS_DRAIN_THRESHOLD_BYTES = 65536;
const WS_DRAIN_MAX_WAIT_MS = 1_000;
const WS_DRAIN_POLL_INTERVAL_MS = 16;

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      // 浏览器 WebSocket 没有 bufferedamountlow 事件，只能轮询 bufferedAmount。
      // 连接已关、队列已排空、或等待超过上限时立刻 resolve——流控不能把发送方卡死。
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount <= WS_DRAIN_THRESHOLD_BYTES) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          if (
            ws.readyState !== WebSocket.OPEN ||
            ws.bufferedAmount <= WS_DRAIN_THRESHOLD_BYTES ||
            Date.now() - startedAt >= WS_DRAIN_MAX_WAIT_MS
          ) {
            resolve();
            return;
          }
          setTimeout(tick, WS_DRAIN_POLL_INTERVAL_MS);
        };
        setTimeout(tick, WS_DRAIN_POLL_INTERVAL_MS);
      });
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      resolve(connectViaProtocol(new SocketProtocol(socket)));
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}
