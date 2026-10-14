import { useEffect } from "react";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";

/** 审查页关窗口时，关掉当前内置浏览器页，而不是停在关闭失败页。 */
export function usePlannotatorGlimpseClose(
  webview: ElectronWebviewTag | null,
  onClose: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!webview || !onClose) return;
    const handleGuestIpcMessage = (event: ElectronWebviewIpcMessageEvent): void => {
      if (event.channel !== EmbeddedBrowserWebviewChannels.PlannotatorGlimpseClose) return;
      onClose();
    };
    webview.addEventListener("ipc-message", handleGuestIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleGuestIpcMessage);
  }, [onClose, webview]);
}
