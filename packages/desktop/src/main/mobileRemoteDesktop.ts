import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, MessageChannelMain, app, ipcMain, type MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";
import { PlatformChannels, windowWorkspaceCatalogSchema, formatZodError } from "@zcode/shared";
import {
  ensureWindowsMobileRemoteFirewall,
  resolveAdvertisedLanIPv4,
} from "./mobileRemoteFirewall.js";
import {
  createMobileRemotePairingController,
  type MobileRemoteHostPort,
} from "./mobileRemotePairing.js";

function wrapMainPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type, listener: (event: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type, listener: (event: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function resolveMobileRemoteWebRoot(): string | null {
  const override = process.env.ZCODE_MOBILE_REMOTE_WEB_ROOT?.trim();
  const candidates = [
    override,
    join(app.getAppPath(), "../web/dist"),
    join(app.getAppPath(), "web-dist"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((path) => existsSync(join(path, "index.html"))) ?? null;
}

export function installMobileRemotePairing(options: {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  getHost(webContentsId: number): MobileRemoteHostPort | undefined;
  attachRemote(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): { port: MessagePortMain; attachmentId: string };
}) {
  const pairing = createMobileRemotePairingController({
    logger: options.logger,
    selectAddress: resolveAdvertisedLanIPv4,
    ensureFirewall: (port) => ensureWindowsMobileRemoteFirewall(port),
    resolveWebRoot: resolveMobileRemoteWebRoot,
    getHost: options.getHost,
    attachRemote(params) {
      const attached = options.attachRemote(params);
      return { attachmentId: attached.attachmentId, port: wrapMainPort(attached.port) };
    },
    createChannel() {
      const channel = new MessageChannelMain();
      return { port1: wrapMainPort(channel.port1), port2: channel.port2 };
    },
    resolveWindow(windowId) {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return null;
      return {
        id: win.id,
        webContentsId: win.webContents.id,
        onClosed(listener) {
          win.once("closed", listener);
        },
      };
    },
  });

  ipcMain.handle(PlatformChannels.StartMobileRemotePairing, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { status: "unavailable", reason: "no-lan-address" } as const;
    return pairing.start(win.id);
  });
  ipcMain.handle(PlatformChannels.StopMobileRemotePairing, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) pairing.stop(win.id);
  });
  ipcMain.on(PlatformChannels.SyncWindowWorkspaceCatalog, (event, payload: unknown) => {
    const parsed = windowWorkspaceCatalogSchema.safeParse(payload);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (!parsed.success) {
      options.logger.warn(
        "[mobile-remote] invalid workspace catalog",
        formatZodError(parsed.error),
      );
      return;
    }
    pairing.setCatalog(win.id, parsed.data);
  });

  return pairing;
}
