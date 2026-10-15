import assert from "node:assert/strict";
import test from "node:test";
import { installPlannotatorGuestClose } from "./plannotatorGlimpseClose.js";

const BRIDGE_KEY = "__zcodePlannotatorGlimpse__";

type FakeWindow = Window & {
  glimpse?: { close?: () => void };
  __zcodePlannotatorCloseInstalled?: boolean;
  listeners: Array<{ type: string; fn: (event: { data?: unknown }) => void }>;
};

function fakeWindow(hostname: string, bridge?: { close: () => void }): FakeWindow {
  const listeners: FakeWindow["listeners"] = [];
  const win = {
    location: { hostname },
    listeners,
    close() {
      throw new Error("native close");
    },
    addEventListener(type: string, fn: (event: { data?: unknown }) => void) {
      listeners.push({ type, fn });
    },
  } as unknown as FakeWindow;
  if (bridge) (win as unknown as Record<string, unknown>)[BRIDGE_KEY] = bridge;
  return win;
}

function useWindow(win: FakeWindow): void {
  (globalThis as { window?: FakeWindow }).window = win;
}

test("loopback close notifies the host and does not blank the guest", () => {
  let notifies = 0;
  const win = fakeWindow("127.0.0.1", {
    close() {
      notifies += 1;
    },
  });
  useWindow(win);
  installPlannotatorGuestClose(BRIDGE_KEY);
  win.close();
  win.glimpse?.close?.();
  const message = win.listeners.find((listener) => listener.type === "message");
  message?.fn({ data: { __plannotator_glimpse_close: true } });
  assert.equal(notifies, 3);
});

test("a second install does not wrap close again", () => {
  let notifies = 0;
  const win = fakeWindow("localhost", {
    close() {
      notifies += 1;
    },
  });
  useWindow(win);
  installPlannotatorGuestClose(BRIDGE_KEY);
  installPlannotatorGuestClose(BRIDGE_KEY);
  win.close();
  assert.equal(notifies, 1);
});

test("other sites keep their own close", () => {
  const win = fakeWindow("example.com", {
    close() {
      throw new Error("bridge");
    },
  });
  const native = win.close;
  useWindow(win);
  installPlannotatorGuestClose(BRIDGE_KEY);
  assert.equal(win.close, native);
  assert.equal(win.glimpse, undefined);
});

test("the bridge can appear on DOMContentLoaded", () => {
  let notifies = 0;
  const win = fakeWindow("localhost");
  useWindow(win);
  installPlannotatorGuestClose(BRIDGE_KEY);
  assert.throws(() => win.close(), /native close/);
  (win as unknown as Record<string, unknown>)[BRIDGE_KEY] = {
    close() {
      notifies += 1;
    },
  };
  const ready = win.listeners.find((listener) => listener.type === "DOMContentLoaded");
  ready?.fn({});
  win.close();
  assert.equal(notifies, 1);
});
