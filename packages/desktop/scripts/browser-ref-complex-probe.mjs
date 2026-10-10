/**
 * 复杂页面探针：iframe、DOM 重排、refDiff。
 * 运行：node packages/desktop/scripts/browser-ref-complex-probe.mjs
 */
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], {
    env: { ...process.env, BROWSER_REF_BATCH_BUNDLE: outfile },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    unlinkSync(outfile);
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow } = await import("electron");
  app.whenReady().then(() => run().catch((error) => {
    console.error(error);
    app.exit(1);
  }));
}

const PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>checkout</title>
<style>body{font:16px sans-serif;margin:24px}button,input{font:inherit;padding:8px}</style>
<h1>Checkout</h1>
<div id="noise"></div>
<form id="form">
  <label>Email <input placeholder="Email"></label>
  <button type="button" id="sign">Sign in</button>
</form>
<iframe name="payment" srcdoc="<label>Card number <input placeholder='Card number'></label><button type='button' id='pay'>Pay</button><script>document.getElementById('pay').addEventListener('click',()=>{document.body.dataset.paid='yes'});</script>"></iframe>
<p id="log">idle</p>
<script>
  const noise = document.getElementById("noise");
  for (let index = 0; index < 80; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Item " + index;
    noise.append(button);
  }
  const sign = document.getElementById("sign");
  sign.addEventListener("click", () => {
    sign.dataset.clicks = String(Number(sign.dataset.clicks || 0) + 1);
    if (!document.getElementById("receipt")) {
      const receipt = document.createElement("button");
      receipt.id = "receipt";
      receipt.type = "button";
      receipt.textContent = "Receipt ready";
      document.body.append(receipt);
    }
  });
</script>`;

function round(value) {
  return Math.round(value * 10) / 10;
}

async function elapsed(fn) {
  const started = performance.now();
  const value = await fn();
  return { ms: round(performance.now() - started), value };
}

async function run() {
  const { app, BrowserWindow } = await import("electron");
  const { captureBrowserRefDiff, captureBrowserRefSnapshot, runBrowserRefBatch } = await import(
    pathToFileURL(process.env.BROWSER_REF_BATCH_BUNDLE).href
  );
  const win = new BrowserWindow({
    height: 800,
    show: true,
    title: "ref complex probe",
    webPreferences: { contextIsolation: true, sandbox: true },
    width: 1100,
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`);
  const contents = win.webContents;
  contents.debugger.attach("1.3");
  const view = {
    cdp: {
      send: (method, params, sessionId) => contents.debugger.sendCommand(method, params, sessionId),
    },
    webContents: {
      canGoBack: () => contents.canGoBack(),
      canGoForward: () => contents.canGoForward(),
      executeJavaScript: (script) => contents.executeJavaScript(script),
      getTitle: () => contents.getTitle(),
      getURL: () => contents.getURL(),
      goBack: () => contents.goBack(),
      goForward: () => contents.goForward(),
      loadURL: (url) => contents.loadURL(url),
      reload: () => contents.reload(),
    },
  };
  await new Promise((resolve) => setTimeout(resolve, 200));
  const snapshot = await elapsed(() => captureBrowserRefSnapshot(view));
  await contents.executeJavaScript(`(() => {
    const decoy = document.createElement("button");
    decoy.type = "button";
    decoy.id = "decoy";
    decoy.textContent = "Decoy";
    decoy.addEventListener("click", () => { decoy.dataset.clicks = "1"; });
    document.getElementById("form").prepend(decoy);
  })()`);
  const batch = await elapsed(() => runBrowserRefBatch(view, actionsFrom(snapshot.value)));
  const diff = await elapsed(() => captureBrowserRefDiff(view));
  const state = await contents.executeJavaScript(`(() => {
    const frame = document.querySelector("iframe").contentDocument;
    return {
      card: frame.querySelector("input").value,
      decoy: document.getElementById("decoy").dataset.clicks || "0",
      email: document.querySelector("input[placeholder='Email']").value,
      paid: frame.body.dataset.paid || "",
      sign: document.getElementById("sign").dataset.clicks || "0",
    };
  })()`);
  const report = {
    batchMs: batch.ms,

    diff: diff.value,
    diffChars: diff.value.length,
    diffMs: diff.ms,
    snapshotChars: snapshot.value.length,
    snapshotMs: snapshot.ms,
    state,
    totalMs: round(snapshot.ms + batch.ms + diff.ms),
    usable:
      state.email === "a@b.co" &&
      state.card === "4242" &&
      state.sign === "1" &&
      state.paid === "yes" &&
      state.decoy === "0" &&
      diff.value.includes("Receipt ready"),
  };
  console.log(`BROWSER_COMPLEX_REPORT ${JSON.stringify(report)}`);
  if (!report.usable) console.log(`BROWSER_COMPLEX_SNAPSHOT ${snapshot.value}`);
  win.close();
  app.exit(report.usable ? 0 : 2);
}

function actionsFrom(snapshot) {
  const find = (needle) => {
    const line = snapshot.split("\n").find((item) => item.includes(needle));
    if (!line) throw new Error(`missing ${needle}\n${snapshot}`);
    return line.trim().split(" ")[0];
  };
  return [
    { op: "fill", ref: find('[textbox] "Email"'), value: "a@b.co" },
    { op: "click", ref: find('[button] "Sign in"') },
    { op: "fill", ref: find('[textbox] "Card number"'), value: "4242" },
    { op: "click", ref: find('[button] "Pay"') },
  ];
}
