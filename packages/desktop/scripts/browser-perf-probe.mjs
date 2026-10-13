/**
 * 内置浏览器单条命令耗时探针。只打开一个本地页面，按生产路径拆 CDP 步骤计时。
 * 不连 agent，也不改产品行为。
 *
 * 运行：在仓库根目录执行
 *   node packages/desktop/scripts/browser-perf-probe.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

if (!process.versions.electron) {
  const esbuild = require("esbuild");
  const outfile = join(here, ".browser-ref-batch.bundle.mjs");
  await esbuild.build({
    bundle: true,
    entryPoints: [join(here, "../src/main/browserView/browserRefBatch.ts")],
    external: ["electron"],
    format: "esm",
    outfile,
    platform: "node",
  });
  const electronPath = require("electron");
  const child = spawn(electronPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      BROWSER_REF_BATCH_BUNDLE: outfile,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  child.on("exit", (code) => {
    unlinkSync(outfile);
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow } = await import("electron");
  app.whenReady().then(() => runProbe().catch((error) => {
    console.error(error);
    app.exit(1);
  }));
}

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>browser perf probe</title>
<style>
  body { font: 16px/1.4 sans-serif; margin: 24px; }
  button, input { font: inherit; padding: 8px 12px; }
  #log { margin-top: 16px; }
  .row { padding: 4px 0; }
</style>
<h1>Browser perf probe</h1>
<form>
  <label>Email <input id="email" name="email" type="email" placeholder="Email"></label>
  <button id="go" type="button">Sign in</button>
</form>
<div id="host"></div>
<iframe id="frame" srcdoc="<button id='inner'>Inside frame</button>"></iframe>
<p id="log">idle</p>
<div id="bulk"></div>
<script>
  const host = document.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  const shadowButton = document.createElement("button");
  shadowButton.id = "shadow-go";
  shadowButton.textContent = "Shadow action";
  shadowButton.dataset.clicks = "0";
  shadowButton.addEventListener("click", () => {
    shadowButton.dataset.clicks = String(Number(shadowButton.dataset.clicks || 0) + 1);
  });
  shadow.append(shadowButton);
  const bulk = document.getElementById("bulk");
  for (let index = 0; index < 800; index += 1) {
    const row = document.createElement("div");
    row.className = "row";
    row.textContent = "row " + index + " lorem ipsum dolor sit amet";
    if (index % 20 === 0) {
      const button = document.createElement("button");
      button.textContent = "Item " + index;
      row.append(button);
    }
    bulk.append(row);
  }
  document.getElementById("go").addEventListener("click", () => {
    document.getElementById("log").textContent = "clicked";
  });
</script>`;

function playwrightSource() {
  const packageJsonPath = require.resolve("playwright-core/package.json");
  const generatedModule = readFileSync(
    join(dirname(packageJsonPath), "lib", "generated", "injectedScriptSource.js"),
    "utf8",
  );
  const assignment = /const source\s*=\s*/.exec(generatedModule);
  if (!assignment) throw new Error("missing playwright source assignment");
  const start = assignment.index + assignment[0].length;
  const quote = generatedModule[start];
  let escaped = false;
  let end = start + 1;
  for (; end < generatedModule.length; end += 1) {
    const character = generatedModule[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      end += 1;
      break;
    }
  }
  const decoded = runInNewContext(generatedModule.slice(start, end), Object.create(null), {
    timeout: 1000,
  });
  if (typeof decoded !== "string") throw new Error("playwright source decode failed");
  return decoded;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    mean: round(mean),
    max: round(sorted.at(-1)),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function runProbe() {
  const { app, BrowserWindow } = await import("electron");
  const source = playwrightSource();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    title: "PiCode browser perf probe",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`);
  const contents = win.webContents;
  contents.debugger.attach("1.3");
  const send = (method, params, sessionId) =>
    contents.debugger.sendCommand(method, params, sessionId);

  const rows = [];
  const record = async (name, fn) => {
    const started = performance.now();
    const value = await fn();
    rows.push({ name, ms: round(performance.now() - started), extra: value });
    return value;
  };

  await record("cdp.baseline.evaluate", async () => {
    await send("Runtime.evaluate", { expression: "1", returnByValue: true });
    return undefined;
  });

  const cold = await setupWorld(send, source);
  rows.push({ name: "session.cold.total", ms: cold.total, extra: cold.parts });
  const contextIds = [cold.contextId];

  const samples = {
    "session.repeat.total": [],
    "session.repeat.enableAndFrame": [],
    "session.repeat.isolatedWorld": [],
    "session.repeat.injectCheck": [],
    "session.repeat.inject": [],
    "snapshot.ai": [],
    "action.probe": [],
    "click.cdp3": [],
    "production.click.rebuildSession": [],
    "reused.click": [],
    "snapshot.refScript": [],
    "ref.resolveCenter": [],
  };

  for (let index = 0; index < 8; index += 1) {
    const again = await setupWorld(send, source);
    contextIds.push(again.contextId);
    pushSample(samples, "session.repeat.total", again.total);
    pushSample(samples, "session.repeat.enableAndFrame", again.parts.enableAndFrame);
    pushSample(samples, "session.repeat.isolatedWorld", again.parts.isolatedWorld);
    pushSample(samples, "session.repeat.injectCheck", again.parts.injectCheck);
    pushSample(samples, "session.repeat.inject", again.parts.inject);

    pushSample(samples, "snapshot.ai", await elapsed(() => aiSnapshot(send, again.contextId)));
    const probeMs = await elapsed(() => actionProbe(send, again.contextId));
    if (probeMs > 100) {
      console.log(`BROWSER_PERF_SLOW action.probe #${index} ${round(probeMs)}ms`);
    }
    pushSample(samples, "action.probe", probeMs);
    pushSample(
      samples,
      "click.cdp3",
      await elapsed(async () => {
        await dispatchClick(send, 80, 90);
      }),
    );
    pushSample(
      samples,
      "production.click.rebuildSession",
      await elapsed(async () => {
        const session = await setupWorld(send, source);
        await actionProbe(send, session.contextId);
        await dispatchClick(send, 80, 90);
      }),
    );
    pushSample(
      samples,
      "reused.click",
      await elapsed(async () => {
        await actionProbe(send, again.contextId);
        await dispatchClick(send, 80, 90);
      }),
    );
    pushSample(samples, "snapshot.refScript", await elapsed(() => refSnapshot(contents)));
    pushSample(samples, "ref.resolveCenter", await elapsed(() => resolveCenter(contents)));
  }

  const comparison = await measureRefBatch(contents, send, source);
  const clicked = await contents.executeJavaScript("document.getElementById('log').textContent");
  const report = {
    playwrightSourceChars: source.length,
    clickLanded: clicked === "clicked",
    isolatedWorldIds: [...new Set(contextIds)],
    isolatedWorldReused: new Set(contextIds).size === 1,
    cold,
    repeats: Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [name, summarize(values)]),
    ),
    comparison,
  };
  writeFileSync(join(here, "browser-perf-probe-result.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`BROWSER_PERF_REPORT ${JSON.stringify(report)}`);
  win.close();
  app.exit(0);
}

async function measureRefBatch(contents, send, source) {
  const bundle = process.env.BROWSER_REF_BATCH_BUNDLE;
  const { captureBrowserRefSnapshot, runBrowserRefBatch } = await import(pathToFileURL(bundle).href);
  const view = {
    webContents: {
      loadURL: (url) => contents.loadURL(url),
      getURL: () => contents.getURL(),
      getTitle: () => contents.getTitle(),
      canGoBack: () => contents.canGoBack(),
      canGoForward: () => contents.canGoForward(),
      goBack: () => contents.goBack(),
      goForward: () => contents.goForward(),
      reload: () => contents.reload(),
      executeJavaScript: (script) => contents.executeJavaScript(script),
    },
    cdp: {
      send: (method, params, sessionId) => contents.debugger.sendCommand(method, params, sessionId),
    },
  };
  const oldSamples = [];
  const newSamples = [];
  let aiChars = 0;
  let refChars = 0;
  let check = null;
  for (let index = 0; index < 8; index += 1) {
    oldSamples.push(
      await elapsed(async () => {
        const session = await setupWorld(send, source);
        const snap = await send("Runtime.evaluate", {
          contextId: session.contextId,
          expression: `(() => {
            const injected = globalThis.__zcodePlaywrightInjected;
            const root = document.body || document.documentElement;
            return injected.incrementalAriaSnapshot(root, { mode: "ai" }).full;
          })()`,
          returnByValue: true,
        });
        aiChars = String(snap.result?.value ?? "").length;
        for (let step = 0; step < 3; step += 1) {
          const again = await setupWorld(send, source);
          await actionProbe(send, again.contextId);
          await dispatchClick(send, 1, 1);
        }
      }),
    );
    await resetProbePage(contents);
    let snapshotText = "";
    newSamples.push(
      await elapsed(async () => {
        snapshotText = await captureBrowserRefSnapshot(view);
        refChars = snapshotText.length;
        await runBrowserRefBatch(view, actionsFromRefs(snapshotText));
      }),
    );
    if (index === 7) check = await readProbeState(contents);
  }
  return {
    check,
    payloadChars: { aiSnapshot: aiChars, refSnapshot: refChars },
    oldSnapshotPlusThreeLocatorActions: summarize(oldSamples),
    refSnapshotPlusBatch: summarize(newSamples),
  };
}

function actionsFromRefs(snapshotText) {
  const find = (needle) => {
    const line = snapshotText.split("\n").find((item) => item.includes(needle));
    if (!line) throw new Error(`ref snapshot missing ${needle}:\n${snapshotText}`);
    return line.split(" ")[0];
  };
  return [
    { op: "fill", ref: find("[input]"), value: "a@b.co" },
    { op: "click", ref: find("Sign in") },
    { op: "click", ref: find("Shadow action") },
  ];
}

function resetProbePage(contents) {
  return contents.executeJavaScript(`(() => {
    document.getElementById("email").value = "";
    document.getElementById("log").textContent = "idle";
    document.getElementById("host").shadowRoot.getElementById("shadow-go").dataset.clicks = "0";
  })()`);
}

function readProbeState(contents) {
  return contents.executeJavaScript(`(() => ({
    email: document.getElementById("email").value,
    log: document.getElementById("log").textContent,
    shadow: document.getElementById("host").shadowRoot.getElementById("shadow-go").dataset.clicks,
  }))()`);
}

function pushSample(samples, name, ms) {
  samples[name].push(ms);
}

async function elapsed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

async function setupWorld(send, source) {
  const started = performance.now();
  const enableStarted = performance.now();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  const tree = await send("Page.getFrameTree");
  const frameId = tree.frameTree?.frame?.id;
  const enableAndFrame = performance.now() - enableStarted;
  const worldStarted = performance.now();
  const world = await send("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "zcode-playwright-locator",
  });
  const isolatedWorld = performance.now() - worldStarted;
  const contextId = world.executionContextId;
  const checkStarted = performance.now();
  const present = await send("Runtime.evaluate", {
    contextId,
    expression: "Boolean(globalThis.__zcodePlaywrightInjected)",
    returnByValue: true,
  });
  const injectCheck = performance.now() - checkStarted;
  const injectStarted = performance.now();
  let injected = false;
  if (present.result?.value !== true) {
    injected = true;
    await send("Runtime.evaluate", {
      contextId,
      expression: `(() => { const module = {}; ${source}
        globalThis.__zcodePlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify({
          browserName: "chromium",
          customEngines: [],
          isUnderTest: false,
          sdkLanguage: "javascript",
          stableRafCount: 1,
          testIdAttributeName: "data-testid",
        })});
        return true; })()`,
      returnByValue: true,
    });
  }
  const inject = performance.now() - injectStarted;
  return {
    contextId,
    injected,
    total: round(performance.now() - started),
    parts: {
      enableAndFrame: round(enableAndFrame),
      isolatedWorld: round(isolatedWorld),
      injectCheck: round(injectCheck),
      inject: round(inject),
    },
  };
}

async function aiSnapshot(send, contextId) {
  await send("Runtime.evaluate", {
    contextId,
    returnByValue: true,
    expression: `(() => {
      const injected = globalThis.__zcodePlaywrightInjected;
      const root = document.body || document.documentElement;
      return injected.incrementalAriaSnapshot(root, { mode: "ai" }).full;
    })()`,
  });
}

async function actionProbe(send, contextId) {
  await send("Runtime.evaluate", {
    contextId,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const injected = globalThis.__zcodePlaywrightInjected;
      const parsed = injected.parseSelector("internal:role=button[name=\\"Sign in\\"i]");
      const element = injected.querySelector(parsed, document, false);
      if (!element) return { count: 0 };
      injected.elementState(element, "visible");
      injected.elementState(element, "enabled");
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const rect = element.getBoundingClientRect();
      return { count: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
  });
}

async function dispatchClick(send, x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function refSnapshot(contents) {
  await contents.executeJavaScript(`(() => {
    const nodes = document.querySelectorAll("a[href], button, input, textarea, select, [role]");
    const refs = new Map();
    const elements = [];
    let count = 0;
    for (const el of nodes) {
      count += 1;
      const ref = "e" + count;
      refs.set(ref, el);
      const rect = el.getBoundingClientRect();
      elements.push({ ref, tag: el.tagName, text: (el.innerText || el.getAttribute("placeholder") || "").slice(0, 80), x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    window.__zcodeRefs = refs;
    return { elements };
  })()`);
}

async function resolveCenter(contents) {
  await contents.executeJavaScript(`(() => {
    const el = window.__zcodeRefs && window.__zcodeRefs.get("e2");
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
  })()`);
}
