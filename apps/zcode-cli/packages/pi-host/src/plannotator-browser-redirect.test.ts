import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePlannotatorBrowserLaunch,
  loadChildProcess,
  plannotatorBrowserLaunchUrl,
  registerPlannotatorBrowserSession,
  setPlannotatorBrowserStreaming,
} from "./plannotator-browser-redirect.js";

const STACK = "at openBrowser (node_modules/@plannotator/pi-extension/server/network.ts:338:15)";

test("child_process can load when the bundle has no import.meta.url", () => {
  assert.equal(typeof loadChildProcess("").spawn, "function");
});

test("plannotator system browser launch is recognized", () => {
  assert.equal(
    plannotatorBrowserLaunchUrl("cmd.exe", ["/c", "start", "", "http://127.0.0.1:9/review"], STACK, {}),
    "http://127.0.0.1:9/review",
  );
  assert.equal(
    plannotatorBrowserLaunchUrl("open", ["http://localhost:9/"], STACK, {}),
    "http://localhost:9/",
  );
  assert.equal(
    plannotatorBrowserLaunchUrl(
      "cmd.exe",
      ["/c", "start", "", "http://127.0.0.1:9/"],
      STACK,
      { PLANNOTATOR_BROWSER: "chrome.exe" },
    ),
    null,
  );
  assert.equal(
    plannotatorBrowserLaunchUrl(
      "cmd.exe",
      ["/c", "start", "", "http://127.0.0.1:9/"],
      STACK,
      { PLANNOTATOR_BROWSER: "none" },
    ),
    "http://127.0.0.1:9/",
  );
  assert.equal(
    plannotatorBrowserLaunchUrl(
      "cmd.exe",
      ["/c", "start", "", "http://127.0.0.1:9/"],
      "at openUrl (adapters/auth/browser.ts:10:1)",
      {},
    ),
    null,
  );
});

test("a single hosted session receives the url; two sessions do not guess", () => {
  const opened: string[] = [];
  const unregister = registerPlannotatorBrowserSession("s1", (url) => {
    opened.push(url);
  });
  try {
    assert.equal(
      consumePlannotatorBrowserLaunch("xdg-open", ["http://localhost:9/a"], STACK, {}),
      "http://localhost:9/a",
    );
    assert.deepEqual(opened, ["http://localhost:9/a"]);
    const unregisterSecond = registerPlannotatorBrowserSession("s2", () => {
      opened.push("s2");
    });
    try {
      assert.equal(
        consumePlannotatorBrowserLaunch("xdg-open", ["http://localhost:9/b"], STACK, {}),
        null,
      );
      assert.deepEqual(opened, ["http://localhost:9/a"]);
      setPlannotatorBrowserStreaming("s2", true);
      try {
        assert.equal(
          consumePlannotatorBrowserLaunch("xdg-open", ["http://localhost:9/c"], STACK, {}),
          "http://localhost:9/c",
        );
        assert.deepEqual(opened, ["http://localhost:9/a", "s2"]);
      } finally {
        setPlannotatorBrowserStreaming("s2", false);
      }
    } finally {
      unregisterSecond();
    }
  } finally {
    unregister();
  }
});
