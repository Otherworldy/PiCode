import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePlannotatorBrowserLaunch,
  deliverPlannotatorSessionUrl,
  forgetPlannotatorSessionUrls,
  loadChildProcess,
  plannotatorBrowserLaunchUrl,
  plannotatorSessionNotifyUrl,
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

test("PLANNOTATOR_BROWSER 的 none 值仍然由宿主接管", () => {
  for (const value of ["none", "off", "no", "false", "0", "true", "1", ":", " NONE "]) {
    assert.equal(
      plannotatorBrowserLaunchUrl(
        "cmd.exe",
        ["/c", "start", "", "http://127.0.0.1:9/"],
        STACK,
        { PLANNOTATOR_BROWSER: value },
      ),
      "http://127.0.0.1:9/",
      value,
    );
  }
  for (const value of ["chrome.exe", "firefox", "/usr/bin/xdg-open"]) {
    assert.equal(
      plannotatorBrowserLaunchUrl(
        "cmd.exe",
        ["/c", "start", "", "http://127.0.0.1:9/"],
        STACK,
        { PLANNOTATOR_BROWSER: value },
      ),
      null,
      value,
    );
  }
});

const NONE_ENV = { PLANNOTATOR_BROWSER: "none" };

test("上游不 spawn 时从插件通知里取会话地址", () => {
  assert.equal(
    plannotatorSessionNotifyUrl(
      "Plannotator session ready: http://127.0.0.1:9/x — Not opening a browser (PLANNOTATOR_BROWSER=none).",
      NONE_ENV,
    ),
    "http://127.0.0.1:9/x",
  );
  assert.equal(
    plannotatorSessionNotifyUrl(
      "Plannotator: plan review opened at http://127.0.0.1:9/x. You can keep chatting while it runs.",
      NONE_ENV,
    ),
    "http://127.0.0.1:9/x",
  );
  assert.equal(
    plannotatorSessionNotifyUrl(
      "Code review opened at http://127.0.0.1:9/x. You can keep chatting while it runs.",
      NONE_ENV,
    ),
    "http://127.0.0.1:9/x",
  );
  assert.equal(
    plannotatorSessionNotifyUrl("Annotation opened at http://127.0.0.1:9/x.", NONE_ENV),
    "http://127.0.0.1:9/x",
  );
  assert.equal(
    plannotatorSessionNotifyUrl(
      "Could not open a browser automatically. Open http://127.0.0.1:9/x to review.",
      NONE_ENV,
    ),
    "http://127.0.0.1:9/x",
  );
  // 显式指定了别的浏览器时交给插件；没设置时也要兜底，远程会话同样不 spawn。
  assert.equal(
    plannotatorSessionNotifyUrl("Code review opened at http://127.0.0.1:9/x.", {
      PLANNOTATOR_BROWSER: "chrome.exe",
    }),
    null,
  );
  assert.equal(
    plannotatorSessionNotifyUrl("Code review opened at http://127.0.0.1:9/x.", {}),
    "http://127.0.0.1:9/x",
  );
  for (const value of ["off", "no", " NO ", "true"]) {
    assert.equal(
      plannotatorSessionNotifyUrl("Code review opened at http://127.0.0.1:9/x.", {
        PLANNOTATOR_BROWSER: value,
      }),
      "http://127.0.0.1:9/x",
      value,
    );
  }
  // 别人的通知、或句子里没有真地址时不管。
  assert.equal(
    plannotatorSessionNotifyUrl("Dev server opened at http://127.0.0.1:5173/.", NONE_ENV),
    null,
  );
  assert.equal(
    plannotatorSessionNotifyUrl("Plannotator session ready: not-a-url", NONE_ENV),
    null,
  );
});

test("同一个审查页地址在一个会话里只交付一次", () => {
  const opened: string[] = [];
  const unregister = registerPlannotatorBrowserSession("s1", (url) => {
    opened.push(url);
  });
  try {
    assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/a"), true);
    assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/a"), false);
    assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/b"), true);
    // spawn 拦截先拿到地址后，通知里的同一个地址不再开第二个页。
    assert.equal(
      consumePlannotatorBrowserLaunch("xdg-open", ["http://localhost:9/c"], STACK, {}),
      "http://localhost:9/c",
    );
    assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/c"), false);
    // 重复地址也必须吞掉插件的这次启动，否则会真的开系统浏览器。
    assert.equal(
      consumePlannotatorBrowserLaunch("xdg-open", ["http://localhost:9/c"], STACK, {}),
      "http://localhost:9/c",
    );
    assert.deepEqual(opened, [
      "http://localhost:9/a",
      "http://localhost:9/b",
      "http://localhost:9/c",
    ]);
    // 审查页关掉之后，同一个地址（固定端口时）可以再开一次。
    forgetPlannotatorSessionUrls("s1");
    assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/c"), true);
    assert.deepEqual(opened, [
      "http://localhost:9/a",
      "http://localhost:9/b",
      "http://localhost:9/c",
      "http://localhost:9/c",
    ]);
  } finally {
    unregister();
  }
  assert.equal(deliverPlannotatorSessionUrl("s1", "http://localhost:9/d"), false);
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
