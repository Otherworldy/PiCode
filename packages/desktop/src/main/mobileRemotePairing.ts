import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { type MessagePortLike } from "@zcode/rpc";
import {
  HostMessageTypes,
  type MobileRemoteFirewallState,
  type MobileRemotePairingStatus,
  type MobileRemoteWorkspaceListItem,
  type WindowWorkspaceCatalogEntry,
} from "@zcode/shared";
import {
  bridgeMobileRemoteRpc,
  listMobileRemoteWorkspaces,
  MOBILE_REMOTE_PAIR_COOKIE,
  mobileRemoteTokensMatch,
  readMobileRemoteToken,
  selectLanIPv4,
} from "./mobileRemoteTransport.js";

export { selectLanIPv4 } from "./mobileRemoteTransport.js";

export interface MobileRemoteHostPort {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
}

export interface MobileRemoteWindowBinding {
  id: number;
  webContentsId: number;
  onClosed(listener: () => void): void;
}

export interface MobileRemoteRemoteAttachment {
  port: MessagePortLike;
  attachmentId: string;
}

interface MobileRemotePairingControllerOptions {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  selectAddress?: () => string | null | Promise<string | null>;
  ensureFirewall?: (port: number) => Promise<MobileRemoteFirewallState | undefined>;
  listenHost?: string;
  resolveWebRoot?: () => string | null;
  getHost(webContentsId: number): MobileRemoteHostPort | undefined;
  attachRemote(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): MobileRemoteRemoteAttachment;
  createChannel(): { port1: MessagePortLike; port2: unknown };
  resolveWindow(windowId: number): MobileRemoteWindowBinding | null;
}

interface PhoneLink {
  generation: number;
  attachmentId: string;
  host: MobileRemoteHostPort;
  dispose(): void;
}

interface PairingSession {
  windowId: number;
  token: string;
  url: string;
  server: ReturnType<typeof createServer>;
  phone: PhoneLink | null;
  phoneGeneration: number;
  closePhone(): void;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};

function isInsideRoot(root: string, filePath: string): boolean {
  const normalizedRoot = normalize(root.endsWith(sep) ? root : root + sep);
  return normalize(filePath).startsWith(normalizedRoot);
}

export function createMobileRemotePairingController(options: MobileRemotePairingControllerOptions) {
  const sessions = new Map<number, PairingSession>();
  const catalogs = new Map<number, WindowWorkspaceCatalogEntry[]>();
  const selectAddress = options.selectAddress ?? selectLanIPv4;
  const listenHost = options.listenHost ?? "0.0.0.0";
  const logger = options.logger;

  function workspacesFor(windowId: number): MobileRemoteWorkspaceListItem[] {
    return listMobileRemoteWorkspaces(catalogs.get(windowId) ?? []);
  }

  function findWorkspace(windowId: number, workspaceKey: string) {
    return workspacesFor(windowId).find((item) => item.workspaceKey === workspaceKey) ?? null;
  }

  async function serveStatic(
    response: ServerResponse,
    root: string | null,
    pathname: string,
  ): Promise<boolean> {
    if (!root) return false;
    const relative = pathname === "/" || pathname === "/mobile" ? "index.html" : pathname.slice(1);
    const filePath = join(root, relative);
    if (!isInsideRoot(root, filePath)) return false;
    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": STATIC_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000",
      });
      response.end(body);
      return true;
    } catch {
      if (pathname.startsWith("/mobile")) {
        return serveStatic(response, root, "/");
      }
      return false;
    }
  }

  function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body));
  }

  async function handleHttp(
    session: PairingSession,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/" && url.searchParams.get("pair")) {
      response.writeHead(302, {
        Location: "/mobile",
        "Set-Cookie": `${MOBILE_REMOTE_PAIR_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Lax; Path=/`,
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (url.pathname === "/api/mobile-remote/workspaces") {
      sendJson(response, 200, { workspaces: workspacesFor(session.windowId) });
      return;
    }
    const served = await serveStatic(response, options.resolveWebRoot?.() ?? null, url.pathname);
    if (served) return;
    if (url.pathname === "/mobile" || url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        "<!doctype html><meta charset=utf-8><title>PiCode</title><p>手机页面还没有构建。先在仓库里构建 Web 后再扫码。</p>",
      );
      return;
    }
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
  }

  function detachPhone(link: PhoneLink): void {
    try {
      link.host.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: link.attachmentId,
      });
    } catch (error) {
      logger.warn("[mobile-remote] detach failed", {
        attachmentId: link.attachmentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function attachPhone(session: PairingSession, ws: WebSocket, workspaceKey: string): void {
    const windowBinding = options.resolveWindow(session.windowId);
    const workspace = workspaceKey ? findWorkspace(session.windowId, workspaceKey) : null;
    // 不带 workspaceKey 时挂本地 Host，手机可以在已有界面里切换本地工作区。
    if (!windowBinding || (workspaceKey && !workspace)) {
      ws.close(4404, "workspace unavailable");
      return;
    }
    const host = options.getHost(windowBinding.webContentsId);
    if (!host) {
      ws.close(1011, "host unavailable");
      return;
    }
    session.closePhone();
    const generation = ++session.phoneGeneration;
    try {
      const attachmentId = randomBytes(16).toString("hex");
      let port: MessagePortLike;
      let boundAttachmentId = attachmentId;
      if (workspace?.kind === "remote") {
        const workspaceIdentity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
        const attached = options.attachRemote({
          windowId: session.windowId,
          remoteSessionId: workspace.remoteSessionId ?? "",
          workspacePath: workspace.workspacePath,
          workspaceIdentity,
          workspaceKey: workspaceIdentity,
          clientMode: "web-remote-replayable",
        });
        port = attached.port;
        boundAttachmentId = attached.attachmentId;
      } else {
        const channel = options.createChannel();
        host.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomBytes(16).toString("hex"),
            attachmentId,
            clientMode: "web-remote-replayable",
            scope: { kind: "local" },
          },
          [channel.port2],
        );
        port = channel.port1;
      }
      const bridge = bridgeMobileRemoteRpc(port, ws);
      const link: PhoneLink = {
        generation,
        attachmentId: boundAttachmentId,
        host,
        dispose() {
          bridge.dispose();
          ws.close();
          detachPhone(this);
        },
      };
      session.phone = link;
      ws.once("close", () => {
        bridge.dispose();
        if (session.phone?.generation !== generation) return;
        detachPhone(link);
        session.phone = null;
      });
    } catch (error) {
      logger.warn("[mobile-remote] attach failed", {
        windowId: session.windowId,
        message: error instanceof Error ? error.message : String(error),
      });
      ws.close(1011, "workspace unavailable");
    }
  }

  function stop(windowId: number): void {
    const session = sessions.get(windowId);
    if (!session) return;
    sessions.delete(windowId);
    session.closePhone();
    session.server.closeAllConnections?.();
    session.server.close();
    logger.info(`[mobile-remote] pairing stopped windowId=${windowId}`);
  }

  async function firewallFor(session: PairingSession): Promise<MobileRemoteFirewallState | undefined> {
    const listened = session.server.address();
    const port = listened && typeof listened === "object" ? listened.port : null;
    if (!port) return undefined;
    return options.ensureFirewall?.(port).catch(() => "blocked" as const);
  }

  async function start(windowId: number): Promise<MobileRemotePairingStatus> {
    const existing = sessions.get(windowId);
    if (existing) {
      const firewall = await firewallFor(existing);
      return { status: "ready", url: existing.url, ...(firewall ? { firewall } : {}) };
    }
    const address = await selectAddress();
    if (!address || address === "127.0.0.1" || address === "::1") {
      return { status: "unavailable", reason: "no-lan-address" };
    }
    const token = randomBytes(32).toString("base64url");
    const session: PairingSession = {
      windowId,
      token,
      url: "",
      server: undefined as unknown as PairingSession["server"],
      phone: null,
      phoneGeneration: 0,
      closePhone() {
        const phone = this.phone;
        this.phone = null;
        phone?.dispose();
      },
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const session = sessions.get(windowId);
      const presented = readMobileRemoteToken(request, url);
      if (!session || !presented || !mobileRemoteTokensMatch(session.token, presented)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      void handleHttp(session, request, response, url).catch((error) => {
        logger.warn("[mobile-remote] http failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) sendJson(response, 500, { error: "unavailable" });
      });
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const session = sessions.get(windowId);
      const presented = readMobileRemoteToken(request, url);
      if (
        !session ||
        url.pathname !== "/ws" ||
        !presented ||
        !mobileRemoteTokensMatch(session.token, presented)
      ) {
        socket.destroy();
        return;
      }
      const workspaceKey = url.searchParams.get("workspaceKey")?.trim() ?? "";
      sockets.handleUpgrade(request, socket, head, (ws) => {
        attachPhone(session, ws, workspaceKey);
      });
    });
    session.server = server;
    sessions.set(windowId, session);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, listenHost, () => resolve());
      });
    } catch (error) {
      sessions.delete(windowId);
      server.close();
      throw error;
    }
    const listened = server.address() as AddressInfo;
    session.url = `http://${address}:${listened.port}/?pair=${encodeURIComponent(token)}`;
    options.resolveWindow(windowId)?.onClosed(() => stop(windowId));
    logger.info(`[mobile-remote] pairing listening windowId=${windowId} port=${listened.port}`);
    const firewall = await firewallFor(session);
    return { status: "ready", url: session.url, ...(firewall ? { firewall } : {}) };
  }

  return {
    start,
    stop,
    stopAll() {
      for (const windowId of Array.from(sessions.keys())) stop(windowId);
    },
    setCatalog(windowId: number, entries: WindowWorkspaceCatalogEntry[]) {
      catalogs.set(windowId, entries);
    },
    clearCatalog(windowId: number) {
      catalogs.delete(windowId);
    },
  };
}
