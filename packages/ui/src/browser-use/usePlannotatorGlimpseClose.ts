import { useEffect } from "react";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 审查页的 window.close 在 webview 里不会关标签，只把已经打开的本机页换成 about:blank。
 * 启动时的 about:blank、恢复中的空白导航、以及从本机页后退回启动页（还能前进）都不关。
 */
export function shouldCloseBlankedLoopbackPage(
  loopbackPageCommitted: boolean,
  nextUrl: string,
  options: { recovering: boolean; canGoForward: boolean },
): boolean {
  return (
    loopbackPageCommitted &&
    !options.recovering &&
    !options.canGoForward &&
    nextUrl === "about:blank"
  );
}

/** dom-ready 后再装一次。preload 若停在启动用的 about:blank 上，审查页文档里的 window.close 仍是原生的。 */
export const PLANNOTATOR_GUEST_CLOSE_MAIN_WORLD_SCRIPT = `(() => {
  const installed = "__zcodePlannotatorCloseInstalled";
  const host = location.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return;
  const bridge = window.__zcodePlannotatorGlimpse__;
  if (!bridge || typeof bridge.close !== "function" || window[installed]) return;
  window[installed] = true;
  const notify = () => {
    try {
      bridge.close();
    } catch {
      /* 宿主不在时不要把审查页打崩成空白。 */
    }
  };
  if (typeof window.glimpse?.close !== "function") window.glimpse = { close: notify };
  window.close = () => {
    notify();
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__plannotator_glimpse_close !== true) return;
    notify();
  });
})();`;

type GuestCloseTarget = {
  addEventListener(type: string, listener: (event: { channel?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { channel?: string }) => void): void;
};

/** glimpse 的 IPC，以及 guest 自己的 close，都只关一次侧栏页。 */
export function attachPlannotatorGuestCloseListeners(
  webview: GuestCloseTarget,
  onClose: () => void,
): () => void {
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const handleGuestIpcMessage = (event: { channel?: string }): void => {
    if (event.channel !== EmbeddedBrowserWebviewChannels.PlannotatorGlimpseClose) return;
    closeOnce();
  };
  const handleGuestClose = (): void => {
    closeOnce();
  };
  webview.addEventListener("ipc-message", handleGuestIpcMessage);
  webview.addEventListener("close", handleGuestClose);
  return () => {
    webview.removeEventListener("ipc-message", handleGuestIpcMessage);
    webview.removeEventListener("close", handleGuestClose);
  };
}

/** 审查页关窗口时，关掉当前内置浏览器页，而不是停在空白页。 */
export function usePlannotatorGlimpseClose(
  webview: ElectronWebviewTag | null,
  onClose: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!webview || !onClose) return;
    return attachPlannotatorGuestCloseListeners(webview, onClose);
  }, [onClose, webview]);
}
