import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";

const root = resolve(import.meta.dirname, "../../..");
const cliPackage = JSON.parse(
  await readFile(join(root, "apps/picode-cli/packages/cli/package.json"), "utf8"),
);
const { registerLinuxDeepLinkProtocol } = await tsImport(
  pathToFileURL(join(root, "packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts")).href,
  import.meta.url,
);
const require = createRequire(import.meta.url);
const FpmTarget = require("app-builder-lib/out/targets/FpmTarget.js").default;
const marker = "Comment=PiCode Desktop App";
const logger = { info() {}, warn() {} };

for (const [preview, name, appId, productName] of [
  ["0", "picode-desktop", "dev.zcode.app", "PiCode"],
  ["1", "picode-desktop-preview", "dev.zcode.app.preview", "PiCode Preview"],
]) {
  test(`${name}: build identity, CLI separation, protocol and fpm metadata`, async () => {
    const identity = resolveDesktopProductIdentity({
      ZCODE_ENV: "production",
      ZCODE_PREVIEW_IDENTITY: preview,
    });
    assert.equal(identity.linuxExecutableName, name);
    assert.equal(identity.linuxPackageName, name);
    assert.equal(identity.appId, appId);
    assert.equal(identity.productName, productName);
    assert.ok(Object.hasOwn(cliPackage.bin, "picode"));
    assert.ok(!Object.hasOwn(cliPackage.bin, name));
    assert.notEqual(name, "picode-cli");

    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const {default:config}=await import("./packages/desktop/electron-builder.config.js"); console.log(JSON.stringify(config));',
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: preview },
      },
    );
    const config = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(config.appId, appId);
    assert.equal(config.productName, productName);
    assert.equal(config.linux.executableName, name);
    assert.deepEqual(config.protocols, [{ name: productName, schemes: ["zcode"] }]);
    assert.equal(config.extraMetadata.homepage, "https://github.com/Otherworldy/PiCode");
    assert.deepEqual(config.extraMetadata.author, { name: "PiCode" });
    assert.ok(!output.includes("dev@zcode.z.ai"));
    for (const target of ["deb", "rpm", "pacman"]) {
      assert.equal(config[target].packageName, name);
      // 验证当前 electron-builder 的真实校验路径：显式 maintainer 可替代 author.email。
      const metadata = await FpmTarget.prototype.computeFpmMetaInfoOptions.call({
        options: { ...config.linux, ...config[target] },
        packager: {
          appInfo: { computePackageUrl: async () => config.extraMetadata.homepage },
          info: { metadata: config.extraMetadata },
        },
      });
      assert.equal(metadata.name, name);
      assert.equal(metadata.maintainer, "PiCode (https://github.com/Otherworldy/PiCode)");
    }
  });

  test(`${name}: Linux desktop Exec/Icon and default handler follow identity`, async (t) => {
    const fixture = await makeFixture(t);
    registerLinuxDeepLinkProtocol({
      ...fixture.options,
      executablePath: `/opt/${name}/${name}`,
      productName,
    });
    const entry = await readFile(join(fixture.applications, `${name}.desktop`), "utf8");
    assert.ok(entry.includes(`Exec="/opt/${name}/${name}" %U`));
    assert.ok(entry.includes(`Icon=${name}\n`));
    assert.ok(entry.includes("MimeType=x-scheme-handler/zcode;"));
    assert.deepEqual(fixture.commands.at(-1), [
      "xdg-mime",
      ["default", `${name}.desktop`, "x-scheme-handler/zcode"],
    ]);
  });
}

test("test backend retains Preview identity", () => {
  assert.equal(
    resolveDesktopProductIdentity({ ZCODE_ENV: "test" }).linuxExecutableName,
    "picode-desktop-preview",
  );
});

for (const systemName of ["zcode.desktop", "picode-desktop.desktop"]) {
  for (const owned of [false, true]) {
    test(`${systemName}: clean only owned legacy registration (owned=${owned})`, async (t) => {
      const fixture = await makeFixture(t);
      const oldPath = join(fixture.applications, "zcode.desktop");
      const currentPath = join(fixture.applications, "picode-desktop.desktop");
      const content = owned ? marker : "[Desktop Entry]\nName=My custom registration";
      await writeFile(oldPath, content);
      await writeFile(currentPath, content);
      await writeFile(join(fixture.system, systemName), "[Desktop Entry]\nName=PiCode");
      registerLinuxDeepLinkProtocol(fixture.options);
      assert.equal(existsSync(oldPath), !owned);
      if (!owned) {
        assert.equal(await readFile(oldPath, "utf8"), content);
        assert.equal(await readFile(currentPath, "utf8"), content);
      } else if (systemName === "picode-desktop.desktop") {
        assert.equal(existsSync(currentPath), false);
      } else {
        assert.ok((await readFile(currentPath, "utf8")).includes("Icon=picode-desktop"));
      }
    });
  }
}

test("AppImage callback preserves executable path and startup flags", async (t) => {
  const fixture = await makeFixture(t);
  registerLinuxDeepLinkProtocol({
    ...fixture.options,
    env: { APPIMAGE: "/home/user/PiCode Preview.AppImage" },
    productName: "PiCode Preview",
    argv: ["--no-sandbox", "--disable-gpu", "zcode://callback", "--inspect=9229"],
  });
  const entry = await readFile(
    join(fixture.applications, "picode-desktop-preview.desktop"),
    "utf8",
  );
  assert.ok(
    entry.includes('Exec="/home/user/PiCode Preview.AppImage" "--no-sandbox" "--disable-gpu" %U'),
  );
  assert.ok(entry.includes("Icon=picode-desktop-preview\n"));
  assert.ok(!entry.includes("--inspect"));
  assert.ok(!entry.includes("zcode://callback"));
});

test("Preview system installation preserves the production AppImage registration", async (t) => {
  const fixture = await makeFixture(t);
  const legacyPath = join(fixture.applications, "zcode.desktop");
  await writeFile(legacyPath, marker);
  await writeFile(join(fixture.system, "picode-desktop-preview.desktop"), "[Desktop Entry]");
  registerLinuxDeepLinkProtocol({ ...fixture.options, productName: "PiCode Preview" });
  assert.equal(await readFile(legacyPath, "utf8"), marker);
  assert.equal(existsSync(join(fixture.applications, "picode-desktop-preview.desktop")), false);
});

async function makeFixture(t) {
  const tempRoot = tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, "picode-desktop-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const applications = join(directory, ".local/share/applications");
  const system = join(directory, "system/applications");
  await mkdir(applications, { recursive: true });
  await mkdir(system, { recursive: true });
  const commands = [];
  return {
    applications,
    system,
    commands,
    options: {
      homeDir: directory,
      executablePath: "/opt/picode-desktop/picode-desktop",
      systemApplicationDirs: [system],
      logger,
      runCommand: (command, args) => {
        commands.push([command, args]);
        return { status: 0 };
      },
    },
  };
}
