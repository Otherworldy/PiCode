// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
const root = join(directory, "zcode");
const runner = join(root, "bin/zcode.mjs");
const workspace = join(directory, "workspace");
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(directory, "data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  TERM: "xterm-256color",
};
let web;
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await mkdir(workspace);
  await exec(process.execPath, [runner, "--help"], { cwd: workspace, env });
  const version = (
    await exec(process.execPath, [runner, "--version"], { cwd: workspace, env })
  ).stdout.trim();
  const noArgs = await exec(process.execPath, [runner], { cwd: workspace, env });
  assert.match(`${noArgs.stdout}${noArgs.stderr}`, /Usage|help|app-server/i);

  let webOutput = "";
  web = spawn(process.execPath, [runner, "--web", "--workspace", workspace, "--no-open"], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout.on("data", (data) => {
    webOutput += data;
  });
  web.stderr.on("data", (data) => {
    webOutput += data;
  });
  let base;
  await until(
    () => {
      base = webOutput.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      return Boolean(base);
    },
    "Web URL",
    () => webOutput,
  );
  let info;
  await until(
    async () => {
      try {
        const response = await fetch(new URL("api/server-info", base), {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        info = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    "Web readiness",
    () => webOutput,
  );
  assert.equal(info.workspaces[0].path, workspace);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/i);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  const socket = new WebSocket(new URL("ws", base.replace("http:", "ws:")));
  await once(socket, "open");
  socket.close();
  await once(socket, "close");
  const exited = once(web, "exit");
  web.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  web = undefined;
  console.log(
    JSON.stringify({
      version,
      platform: process.platform,
      arch: process.arch,
      tui: "removed; no-args prints help",
      web: "HTML, server-info, workspace, WebSocket, shutdown passed",
      isolated: true,
    }),
  );
} finally {
  web?.kill();
  await rm(directory, { recursive: true, force: true });
}

async function until(check, label, diagnostic) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error(`${label} timed out:\n${diagnostic()}`);
}
