import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";
import { attachPlannotatorGuestCloseListeners } from "./usePlannotatorGlimpseClose.js";

test("ipc and the guest close event close the tab once", () => {
  const listeners = new Map<string, (event: { channel?: string }) => void>();
  const webview = {
    addEventListener(type: string, listener: (event: { channel?: string }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  };
  let closes = 0;
  attachPlannotatorGuestCloseListeners(webview, () => {
    closes += 1;
  });
  listeners.get("ipc-message")?.({
    channel: EmbeddedBrowserWebviewChannels.PlannotatorGlimpseClose,
  });
  listeners.get("close")?.({});
  listeners.get("ipc-message")?.({ channel: "other" });
  assert.equal(closes, 1);
});
