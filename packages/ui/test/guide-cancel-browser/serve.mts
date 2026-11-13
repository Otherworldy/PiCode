import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HostSessionRegistry,
  createSdkSessionFactory,
} from "../../../../apps/picode-cli/packages/pi-host/src/index.js";

// 浏览器点击真实组件，并由真实 Pi SDK 决定取消或消费；产物仅写临时目录。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtureRoot = process.platform === "win32" ? "D:/tmp" : tmpdir();
await mkdir(fixtureRoot, { recursive: true });
const output = await mkdtemp(join(fixtureRoot, "picode-guide-cancel-browser-"));
const require = createRequire(join(root, "packages/desktop/package.json"));
const { build } = require("esbuild");
const shared = JSON.parse(await readFile(join(root, "packages/shared/package.json"), "utf8"));
await build({
  entryPoints: [join(root, "packages/ui/test/guide-cancel-browser/fixture.tsx")],
  outfile: join(output, "app.js"),
  bundle: true,
  platform: "browser",
  jsx: "automatic",
  format: "esm",
  nodePaths: [join(root, "packages/ui/node_modules"), join(root, "node_modules")],
  alias: {
    "@": join(root, "packages/ui/src"),
    ...Object.fromEntries(
      Object.entries(shared.exports).map(([key, path]) => [
        `@picode/shared${key === "." ? "" : key.slice(1)}`,
        resolve(root, "packages/shared", path as string),
      ]),
    ),
  },
  plugins: [
    {
      name: "fixture-assets",
      setup(builder: import("esbuild").PluginBuild) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({
          path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
          namespace: "fixture-url",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, async (args) => ({
          contents: await readFile(args.path),
          loader: "file",
        }));
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "fixture-raw",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-raw" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": '{"DEV":false,"PROD":true,"BASE_URL":"/"}',
  },
  logLevel: "warning",
});
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let calls = 0;
const registry = new HostSessionRegistry({
  storageRoot: join(output, "state"),
  nativeSessionsRoot: join(output, "sessions"),
  loadExtensions: false,
  createSession: createSdkSessionFactory({
    agentDir: join(output, "agent"),
    stream: async function* () {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: "text", text: "done" };
      yield { type: "done" };
    },
  }),
  readTitleSummarySettings: async () => ({ enabled: false }),
  completeMemoryPrompt: async () => {
    throw new Error("unexpected memory request");
  },
});
const hosted = await registry.create({ workspacePath: output });
await hosted.bridge.admitSend({
  text: "initial",
  commandId: "initial",
  clientId: "fixture",
  delivery: "startNow",
  streaming: false,
});
await entered.promise;
let nextCommand = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><meta charset="utf-8"><title>PiCode Guide Cancel Check</title><div id="root"></div><script type="module" src="/app.js"></script>',
      );
      return;
    }
    if (request.url === "/app.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(await readFile(join(output, "app.js")));
      return;
    }
    console.log("fixture request", request.method, request.url);
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    let result = "snapshot";
    if (request.url === "/send") {
      result = (
        await hosted.bridge.admitSend({
          text: input.text,
          commandId: `guide-${++nextCommand}`,
          clientId: "fixture",
          delivery: "guide",
          streaming: true,
        })
      ).kind;
      hosted.projector.replaceQueue(hosted.queue.snapshot());
    } else if (request.url === "/cancel") {
      result = hosted.bridge.cancelGuide(input.queueItemId) ? "cancelled" : "already consumed";
      hosted.projector.replaceQueue(hosted.queue.snapshot());
    } else if (request.url === "/release") {
      release.resolve();
      await hosted.waitTurn();
      result = "completed";
    } else if (request.url !== "/snapshot") {
      response.statusCode = 404;
      response.end();
      return;
    }
    console.log("fixture result", request.url, result);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result, snapshot: hosted.projector.getSnapshot() }));
  } catch (error) {
    response.statusCode = 500;
    response.end(
      JSON.stringify({ result: String(error), snapshot: hosted.projector.getSnapshot() }),
    );
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log(
    `Guide cancel ready http://127.0.0.1:${(server.address() as { port: number }).port}/`,
  );
});
process.on("SIGTERM", () => {
  release.resolve();
  void hosted.dispose().finally(() => server.close());
});
