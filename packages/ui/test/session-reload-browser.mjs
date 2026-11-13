import assert from "node:assert/strict";
import { build } from "esbuild";
import { _electron as electron } from "playwright-core";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 与 desktop/scripts/*-e2e.mjs 一样使用已安装的 esbuild、Electron 和浏览器驱动。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempRoot = process.platform === "win32" ? "D:/tmp" : "/tmp";
await mkdir(tempRoot, { recursive: true });
const output = await mkdtemp(join(tempRoot, "picode-session-reload-"));
const shared = JSON.parse(await readFile(join(root, "packages/shared/package.json"), "utf8"));
await build({
  entryPoints: [join(root, "packages/ui/test/session-reload-browser/fixture.tsx")],
  outfile: join(output, "fixture.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: {
    "@": join(root, "packages/ui/src"),
    ...Object.fromEntries(
      Object.entries(shared.exports).map(([key, path]) => [
        `@picode/shared${key === "." ? "" : key.slice(1)}`,
        resolve(root, "packages/shared", path),
      ]),
    ),
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": '{"PROD":true,"DEV":false}',
  },
  logLevel: "warning",
});
await writeFile(
  join(output, "index.html"),
  '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>',
);
await writeFile(
  join(output, "main.cjs"),
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});win.loadFile(${JSON.stringify(join(output, "index.html"))});});`,
);
const browserEnv = { ...process.env };
delete browserEnv.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [join(output, "main.cjs")],
  timeout: 20_000,
  env: browserEnv,
});
try {
  const page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [mode, locale, reloadLabel] of [
    ["desktop-continuous", "en-US", "Reload current session"],
    ["web-remote-replayable", "zh-CN", "重载当前会话"],
  ]) {
    await page.goto(
      `file:///${join(output, "index.html").replaceAll("\\", "/")}?mode=${mode}&locale=${locale}`,
    );
    await page.getByRole("button", { name: "Session menu" }).waitFor();
    await page.getByRole("textbox", { name: "Draft" }).fill("keep my draft");
    await page.getByRole("button", { name: "Session menu" }).focus();
    await page.keyboard.press("ArrowDown");
    const item = page.getByRole("menuitem", { name: reloadLabel });
    await item.waitFor();
    assert.equal(
      await item.getAttribute("aria-disabled"),
      null,
      "sibling busy must not disable current session",
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.reloadScenario.commands.length === 1);
    await page.evaluate(() => window.reloadScenario.reloadTwice());
    assert.equal(await page.getByTestId("pending").textContent(), "true");
    assert.equal(
      await page.evaluate(() => window.reloadScenario.commands.length),
      1,
      "pending must suppress duplicate clicks",
    );
    assert.equal(
      await page.evaluate(() => window.reloadScenario.restarts.length),
      0,
      "session reload must not restart workspace",
    );
    await page.getByRole("button", { name: "Session menu" }).click();
    assert.equal(await item.getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      window.reloadScenario.resolve({
        status: "accepted",
        result: {
          type: "reloadSession",
          slashCommands: [{ name: "fresh-command", description: "Fresh extension" }],
        },
      }),
    );
    await page.waitForFunction(
      () => document.querySelector('[data-testid="pending"]').textContent === "false",
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="catalogs"]').textContent ===
        "fresh-skill|fresh-plugin|tool-2",
    );
    await page.evaluate(() => window.reloadScenario.releaseOld());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(
      await page.getByTestId("catalogs").textContent(),
      "fresh-skill|fresh-plugin|tool-2",
      "late pre-reload catalogs must be discarded",
    );
    assert.equal(await page.getByTestId("commands").textContent(), "fresh-command");
    assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "keep my draft");
    const command = await page.evaluate(() => window.reloadScenario.commands[0]);
    assert.equal(command.workspaceIdentity, "remote-workspace");
    assert.equal(command.envelope.sessionId, "current-session");
    assert.equal(command.envelope.type, "reloadSession");
    assert.deepEqual(command.envelope.payload, {});
    assert.equal(command.envelope.baseRevision, undefined);
    assert.equal(await page.evaluate(() => window.reloadScenario.localCommands), 0);
    assert.equal(
      await page.evaluate(() => window.reloadScenario.handshakes[0].clientId),
      command.envelope.clientId,
    );

    // Host 在 UI 空闲投影之后仍可判 busy；failed ACK 不得变成成功提示或目录刷新。
    await page.evaluate(() => window.reloadScenario.reloadTwice());
    await page.waitForFunction(() => window.reloadScenario.commands.length === 2);
    await page.evaluate(() =>
      window.reloadScenario.resolve({
        status: "failed",
        message: "extension initialization failed",
        reasonCode: "fault.command.sessionReloadFailed",
      }),
    );
    await page.getByText(/extension initialization failed/).waitFor();
    assert.equal(await page.evaluate(() => window.reloadScenario.skillQueries), 2);
    await page.evaluate(() => window.reloadScenario.reloadTwice());
    await page.waitForFunction(() => window.reloadScenario.commands.length === 3);
    await page.evaluate(() =>
      window.reloadScenario.resolve({ status: "rejected", reasonCode: "guard.sessionReloadBusy" }),
    );
    await page
      .getByText(locale === "en-US" ? /This session is busy/ : /当前会话正在处理任务/)
      .waitFor();

    await page.evaluate(() => window.reloadScenario.setBusy(true));
    await page.getByRole("button", { name: "Session menu" }).click();
    assert.equal(
      await item.getAttribute("aria-disabled"),
      "true",
      "own session busy disables action",
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.reloadScenario.setBusy(false));
    await page.evaluate(() => window.reloadScenario.reloadTwice());
    await page.waitForFunction(() => window.reloadScenario.commands.length === 4);
    await page.evaluate(() => {
      window.reloadScenario.switchSession("another-session");
      window.reloadScenario.resolve({
        status: "accepted",
        result: {
          type: "reloadSession",
          slashCommands: [{ name: "late-command", description: "old session" }],
        },
      });
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="pending"]').textContent === "false",
    );
    assert.notEqual(
      await page.getByTestId("commands").textContent(),
      "late-command",
      "late ACK must not write into the new session",
    );
    assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "keep my draft");

    await page.evaluate(() => window.reloadScenario.switchSession(null));
    await page.getByRole("button", { name: "Session menu" }).click();
    assert.equal(
      await item.getAttribute("aria-disabled"),
      "true",
      "draft has no session reload action",
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.reloadScenario.reloadStaleSession("current-session"));
    assert.equal(
      await page.evaluate(() => window.reloadScenario.restarts.length),
      0,
      "a stale explicit session id must not fall back to workspace restart",
    );
    assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "keep my draft");
    console.log(`PASS session reload browser: ${mode}, ${locale}`);
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
}
