import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { WebSocket } from "ws";
import {
  Emitter,
  MessagePortProtocol,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type MessagePortLike,
} from "@zcode/rpc";
import {
  resolveWorkspaceKey,
  type MobileRemoteWorkspaceListItem,
  type WindowWorkspaceCatalogEntry,
} from "@zcode/shared";

export const MOBILE_REMOTE_PAIR_COOKIE = "zcode_mobile_pair";

export function selectLanIPv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || entry.address.startsWith("169.254.")) {
        continue;
      }
      candidates.push(entry.address);
    }
  }
  return (
    candidates.find(
      (address) =>
        address.startsWith("192.168.") ||
        address.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address),
    ) ??
    candidates[0] ??
    null
  );
}

export function mobileRemoteTokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function readMobileRemoteToken(request: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get("pair");
  if (query) return query;
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== MOBILE_REMOTE_PAIR_COOKIE) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function listMobileRemoteWorkspaces(
  entries: readonly WindowWorkspaceCatalogEntry[],
): MobileRemoteWorkspaceListItem[] {
  const seen = new Set<string>();
  const items: MobileRemoteWorkspaceListItem[] = [];
  for (const entry of entries) {
    const workspaceKey = resolveWorkspaceKey(entry);
    if (seen.has(workspaceKey)) continue;
    seen.add(workspaceKey);
    const workspaceIdentity = entry.workspaceIdentity?.trim() || undefined;
    items.push({
      workspaceKey,
      workspacePath: entry.workspacePath,
      label: entry.label,
      kind: entry.remoteSessionId ? "remote" : "local",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
    });
  }
  return items;
}

function wrapNodeWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(bytes)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      // 与 packages/server 的 ws 包装保持一致：按 bufferedAmount 轮询判定，
      // 不伪造「已经排空」的信号。
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= 65536) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          if (
            ws.readyState !== ws.OPEN ||
            ws.bufferedAmount <= 65536 ||
            Date.now() - startedAt >= 1_000
          ) {
            resolve();
            return;
          }
          setTimeout(tick, 16);
        };
        setTimeout(tick, 16);
      });
    },
    dispose() {
      ws.close();
    },
  };
}

export function bridgeMobileRemoteRpc(port: MessagePortLike, ws: WebSocket): { dispose(): void } {
  const messagePort = new MessagePortProtocol(port);
  const socketProtocol = new SocketProtocol(wrapNodeWebSocket(ws));
  let disposed = false;
  const toSocket = messagePort.onMessage((buffer) => {
    if (!disposed) socketProtocol.send(buffer);
  });
  const toPort = socketProtocol.onMessage((buffer) => {
    if (!disposed) messagePort.send(buffer);
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      toSocket.dispose();
      toPort.dispose();
      socketProtocol.dispose();
      messagePort.disconnect();
    },
  };
}
