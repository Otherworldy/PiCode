import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";
import {
  attachPlannotatorGuestCloseListeners,
  isLoopbackHttpUrl,
  PLANNOTATOR_GUEST_CLOSE_MAIN_WORLD_SCRIPT,
  shouldCloseBlankedLoopbackPage,
} from "./usePlannotatorGlimpseClose.js";

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

test("a loopback review page that lands on about:blank closes the tab", () => {
  assert.equal(isLoopbackHttpUrl("http://127.0.0.1:9/review"), true);
  assert.equal(isLoopbackHttpUrl("http://localhost:9/"), true);
  assert.equal(isLoopbackHttpUrl("https://example.com/"), false);
  assert.equal(isLoopbackHttpUrl("about:blank"), false);
  const open = { recovering: false, canGoForward: false };
  assert.equal(shouldCloseBlankedLoopbackPage(false, "about:blank", open), false);
  assert.equal(
    shouldCloseBlankedLoopbackPage(true, "http://127.0.0.1:9/review", open),
    false,
  );
  assert.equal(
    shouldCloseBlankedLoopbackPage(true, "about:blank", { recovering: true, canGoForward: false }),
    false,
  );
  assert.equal(
    shouldCloseBlankedLoopbackPage(true, "about:blank", { recovering: false, canGoForward: true }),
    false,
  );
  assert.equal(shouldCloseBlankedLoopbackPage(true, "about:blank", open), true);
});

test("main world script hooks loopback close and ignores other sites", () => {
  const hooked = fakePage("127.0.0.1");
  vm.runInContext(PLANNOTATOR_GUEST_CLOSE_MAIN_WORLD_SCRIPT, hooked.context);
  hooked.window.close();
  assert.equal(hooked.notifies, 1);
  const other = fakePage("example.com");
  vm.runInContext(PLANNOTATOR_GUEST_CLOSE_MAIN_WORLD_SCRIPT, other.context);
  assert.throws(() => other.window.close(), /native close/);
  assert.equal(other.notifies, 0);
});

function fakePage(hostname: string): {
  context: vm.Context;
  notifies: number;
  window: { close: () => void };
} {
  let notifies = 0;
  const window = {
    location: { hostname },
    __zcodePlannotatorGlimpse__: {
      close() {
        notifies += 1;
      },
    },
    glimpse: undefined as { close?: () => void } | undefined,
    close() {
      throw new Error("native close");
    },
    addEventListener() {
      return undefined;
    },
  };
  const context = vm.createContext({ window, location: window.location });
  return {
    context,
    get notifies() {
      return notifies;
    },
    window,
  };
}
