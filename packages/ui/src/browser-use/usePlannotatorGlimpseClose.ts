import { useEffect } from "react";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";

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
