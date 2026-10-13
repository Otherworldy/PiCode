import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpawnOptions } from "node:child_process";
import { isRecommendedPiPluginInstalled, normalizePiPluginInstallSource } from "@zcode/shared";
import {
  applyZcodePluginPlan,
  installPiPlugin,
  isPlannotatorPiExtension,
  listPiPlugins,
  piPluginPackageSource,
  removePiPlugin,
  searchPiPackageCatalog,
  setPiPluginEnabled,
  silencePackageManagerStdout,
  updatePiPlugin,
  zcodePluginSourceId,
} from "./pi-plugins.js";

test("recommended plugins match only the same scope package", () => {
  const plugins = [
    {
      id: "pkg:user:npm:@plannotator/pi-extension",
      detail: "npm:@plannotator/pi-extension",
      name: "pi-extension",
      scope: "user",
      kind: "package",
    },
    {
      id: "pkg:project:git:github.com/Otherworldy/pi-ask-me",
      detail: "git:github.com/Otherworldy/pi-ask-me",
      name: "pi-ask-me",
      scope: "project",
      kind: "package",
    },
  ];
  assert.equal(
    isRecommendedPiPluginInstalled(plugins, "npm:@plannotator/pi-extension", "user"),
    true,
  );
  assert.equal(
    isRecommendedPiPluginInstalled(plugins, "npm:@plannotator/pi-extension", "project"),
    false,
  );
  assert.equal(
    isRecommendedPiPluginInstalled(plugins, "git:github.com/Otherworldy/pi-ask-me", "user"),
    false,
  );
  assert.equal(
    isRecommendedPiPluginInstalled(
      plugins,
      "https://github.com/Otherworldy/pi-processes-bash",
      "user",
    ),
    false,
  );
  assert.equal(
    isRecommendedPiPluginInstalled(
      [
        {
          id: "pkg:user:D:\\Study\\Code\\Node\\pi-processes",
          detail: "D:\\Study\\Code\\Node\\pi-processes",
          name: "pi-processes",
          scope: "user",
          kind: "package",
        },
      ],
      "https://github.com/Otherworldy/pi-processes-bash",
      "user",
    ),
    true,
  );
});

test("settings install accepts npm and git sources and rejects local or shell sources", async () => {
  assert.equal(normalizePiPluginInstallSource("pi-subagents"), "npm:pi-subagents");
  assert.equal(
    normalizePiPluginInstallSource("npm:@Plannotator/pi-extension"),
    "npm:@plannotator/pi-extension",
  );
  assert.equal(
    normalizePiPluginInstallSource("npm:@scope/name@1.2.3"),
    "npm:@scope/name@1.2.3",
  );
  assert.equal(
    normalizePiPluginInstallSource("git:github.com/Otherworldy/pi-ask-me"),
    "git:github.com/Otherworldy/pi-ask-me",
  );
  assert.equal(
    normalizePiPluginInstallSource("https://github.com/Otherworldy/pi-processes-bash"),
    "https://github.com/Otherworldy/pi-processes-bash",
  );
  assert.equal(
    normalizePiPluginInstallSource("git:gitlab.com/group/sub/repo@main"),
    "git:gitlab.com/group/sub/repo@main",
  );
  assert.equal(normalizePiPluginInstallSource("../secret"), null);
  assert.equal(normalizePiPluginInstallSource("file:/tmp/plugin"), null);
  assert.equal(normalizePiPluginInstallSource("npm:foo;rm"), null);
  assert.equal(normalizePiPluginInstallSource("https://user@github.com/a/b"), null);
  assert.equal(normalizePiPluginInstallSource("http://github.com/a/b"), null);
  await assert.rejects(
    () => installPiPlugin(process.cwd(), "npm:foo;rm", "user"),
    /not installable/,
  );
});

test("package catalog keeps only the pi-package keyword", async () => {
  const page = await searchPiPackageCatalog("web", 0, async () => {
    return new Response(
      JSON.stringify({
        total: 2,
        objects: [
          {
            package: {
              name: "pi-web-access",
              description: "Web search",
              version: "1.2.3",
              keywords: ["pi-package"],
            },
          },
          {
            package: {
              name: "unrelated",
              description: "Not a Pi package",
              version: "0.0.1",
              keywords: ["other"],
            },
          },
        ],
      }),
      { status: 200 },
    );
  });
  assert.deepEqual(page, {
    from: 0,
    total: 2,
    packages: [
      {
        name: "pi-web-access",
        description: "Web search",
        version: "1.2.3",
        source: "npm:pi-web-access",
      },
    ],
  });
  await assert.rejects(
    () => searchPiPackageCatalog("", 0, async () => new Response("", { status: 503 })),
    /503/,
  );
});

test("catalog kind and download sort go to the registry query", async () => {
  let seen = "";
  const page = await searchPiPackageCatalog(
    "web",
    0,
    async (input) => {
      const url = String(input);
      if (url.includes("/-/v1/search")) seen = url;
      return new Response(
        JSON.stringify({
          total: 1,
          objects: [
            {
              package: {
                name: "pi-web-access",
                description: "Web",
                version: "1.0.0",
                keywords: ["pi-package", "extension"],
                date: "2026-01-02T03:04:05.000Z",
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
    { kind: "extension", sort: "downloads" },
  );
  assert.match(seen, /keywords%3Api-package\+keywords%3Aextension\+web/);
  assert.match(seen, /popularity=1/);
  assert.equal(page.packages[0]?.publishedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(page.packages[0]?.kinds, ["extension"]);
});

test("catalog image keeps https pi.image and drops anything else", async () => {
  const page = await searchPiPackageCatalog("", 0, async (input) => {
    const url = String(input);
    if (url.includes("/-/v1/search")) {
      return new Response(
        JSON.stringify({
          total: 2,
          objects: [
            {
              package: {
                name: "pi-pictured",
                description: "",
                version: "1.0.0",
                keywords: ["pi-package"],
              },
            },
            {
              package: {
                name: "pi-plain",
                description: "",
                version: "1.0.0",
                keywords: ["pi-package"],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/pi-pictured/1.0.0")) {
      return new Response(
        JSON.stringify({
          pi: { image: "https://example.com/logo.png", video: "https://example.com/a.mp4" },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ pi: { image: "javascript:alert(1)" } }), { status: 200 });
  });
  assert.equal(page.packages[0]?.image, "https://example.com/logo.png");
  assert.equal(page.packages[1]?.image, undefined);
});

test("plan mode matches only an enabled plannotator pi extension", () => {
  assert.equal(
    isPlannotatorPiExtension({
      id: "pkg:user:npm:@plannotator/pi-extension",
      detail: "npm:@plannotator/pi-extension",
      name: "pi-extension",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    isPlannotatorPiExtension({
      id: "pkg:user:npm:@plannotator/pi-extension",
      detail: "npm:@plannotator/pi-extension",
      name: "pi-extension",
      enabled: false,
    }),
    false,
  );
  assert.equal(
    isPlannotatorPiExtension({
      id: "pkg:user:npm:other",
      detail: "npm:other",
      name: "other",
      enabled: true,
    }),
    false,
  );
});

test("plugin update spawn does not inherit protocol stdout", () => {
  const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const manager: {
    spawnCommand: (command: string, args: string[], options?: { cwd?: string }) => unknown;
  } = {
    spawnCommand() {
      throw new Error("inherit");
    },
  };
  silencePackageManagerStdout(manager, (command, args, options) => {
    seen.push({ command, args, options });
    return { on() {} } as never;
  });
  manager.spawnCommand("npm", ["install", "pkg@latest", "--prefix", "C:\\Users\\a b\\npm"]);
  manager.spawnCommand("git", ["pull"], { cwd: "repo" });
  assert.deepEqual(seen[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(seen[0]?.options.windowsHide, true);
  assert.equal(seen[0]?.options.shell, process.platform === "win32");
  assert.equal(
    seen[0]?.args.at(-1),
    process.platform === "win32" ? '"C:\\Users\\a b\\npm"' : "C:\\Users\\a b\\npm",
  );
  assert.equal(seen[1]?.options.shell, false);
  assert.deepEqual(seen[1]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(seen[1]?.options.cwd, "repo");
  assert.deepEqual(seen[1]?.args, ["pull"]);
});

test("only package ids can be updated", async () => {
  assert.deepEqual(piPluginPackageSource("pkg:user:npm:@scope/pkg"), {
    scope: "user",
    source: "npm:@scope/pkg",
  });
  await assert.rejects(
    () => updatePiPlugin(process.cwd(), "ext:user:extensions/demo.ts"),
    /cannot be updated/,
  );
});

test("lists and toggles Pi packages and extension files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugins-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  const pkgDir = join(root, "local-pkg");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(agentDir, "extensions", "demo.ts"), "export default function () {}\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));

  const listed = await listPiPlugins(cwd, agentDir, root);
  const pkg = listed.find((row) => row.kind === "package");
  const ext = listed.find((row) => row.kind === "extension");
  assert.equal(pkg?.enabled, true);
  assert.equal(pkg?.scope, "user");
  assert.equal(ext?.detail, "extensions/demo.ts");
  assert.equal(ext?.enabled, true);

  await setPiPluginEnabled(cwd, pkg!.id, false, agentDir, root);
  await setPiPluginEnabled(cwd, ext!.id, false, agentDir, root);
  const saved = await readFile(join(agentDir, "settings.json"), "utf8");
  assert.equal(saved, JSON.stringify({ packages: [pkgDir] }));
  const switches = JSON.parse(
    await readFile(join(root, "pi-plugin-switches.json"), "utf8"),
  ) as Record<string, boolean>;
  assert.equal(switches[pkg!.id], false);
  assert.equal(switches[ext!.id], false);

  const after = await listPiPlugins(cwd, agentDir, root);
  assert.equal(after.find((row) => row.id === pkg!.id)?.enabled, false);
  assert.equal(after.find((row) => row.id === ext!.id)?.enabled, false);
  const info = {
    origin: "package",
    source: pkgDir,
    scope: "user",
  };
  assert.equal(zcodePluginSourceId(info, pkgDir), pkg!.id);
  await removePiPlugin(cwd, pkg!.id, agentDir, root);
  await removePiPlugin(cwd, ext!.id, agentDir, root);
  const gone = await listPiPlugins(cwd, agentDir, root);
  assert.equal(
    gone.find((row) => row.id === pkg!.id),
    undefined,
  );
  assert.equal(
    gone.find((row) => row.id === ext!.id),
    undefined,
  );
  assert.equal(existsSync(join(agentDir, "extensions", "demo.ts")), false);
  await assert.rejects(
    () => removePiPlugin(cwd, "ext:user:extensions/../../settings.json", agentDir, root),
    /cannot be removed/,
  );
  const extensions = [
    { path: pkgDir, sourceInfo: info },
    {
      path: join(agentDir, "extensions", "demo.ts"),
      sourceInfo: {
        origin: "top-level",
        source: "auto",
        scope: "user",
        baseDir: agentDir,
      },
    },
  ];
  applyZcodePluginPlan(
    {
      getExtensions: () => ({ extensions }),
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({ prompts: [] }),
    },
    { extensionPaths: [], skillPaths: [], promptPaths: [], disabled: new Set([pkg!.id, ext!.id]) },
  );
  assert.equal(extensions.length, 0);
});
