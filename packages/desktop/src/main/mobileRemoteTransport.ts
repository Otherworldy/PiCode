import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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

/** 手机锁屏或浏览器进程被系统回收后还要能连回来，口令 cookie 持久 30 天。 */
const MOBILE_REMOTE_PAIR_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // 畸形 cookie 只当作没有口令。抛出去会变成 Main 的未捕获异常，同网段任何人都能触发。
      return null;
    }
  }
  return null;
}

/** 扫码进入：下发持久 cookie，并把手机送到移动端页面。 */
export function sendMobileRemotePairCookieRedirect(
  response: ServerResponse,
  token: string,
): void {
  response.writeHead(302, {
    Location: "/mobile",
    "Set-Cookie": `${MOBILE_REMOTE_PAIR_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MOBILE_REMOTE_PAIR_COOKIE_MAX_AGE_SECONDS}`,
    "Cache-Control": "no-store",
  });
  response.end();
}

/** 浏览器导航请求要一页可读提示；接口调用仍按 401 JSON 处理。 */
export function wantsMobileRemoteHtml(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

/**
 * 口令对不上曾经把 401 JSON 原文摊在手机页面上，用户只看到「未授权」，不知道该重新扫码。
 */
export function sendMobileRemotePairingExpired(
  response: ServerResponse,
  request: IncomingMessage,
): void {
  const language = request.headers["accept-language"] ?? "";
  const message = /^zh\b/i.test(language)
    ? "手机配对已失效。请在桌面重新打开「手机远程控制」并重新扫码。"
    : "Pairing expired. Reopen Mobile Remote on the desktop and scan the QR code again.";
  response.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset=utf-8><meta name="viewport" content="width=device-width,initial-scale=1"><title>PiCode</title><p>${message}</p>`,
  );
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
