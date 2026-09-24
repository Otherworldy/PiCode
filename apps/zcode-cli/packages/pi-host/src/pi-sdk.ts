import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZCODE_PI_SDK_ENV_KEY, type ZCodePiSdkStatus } from "@zcode/shared";
import * as bundledCoding from "@earendil-works/pi-coding-agent";

let coding: typeof bundledCoding = bundledCoding;
let status: ZCodePiSdkStatus = {
  requested: "builtin",
  active: "builtin",
  builtinVersion: readBundledVersion(),
};
let pending: Promise<void> | undefined;

/** 当前进程实际用的 Pi。全局加载失败时仍是打进包里的那份。 */
export function piCoding(): typeof bundledCoding {
  return coding;
}

export function getPiSdkStatus(): ZCodePiSdkStatus {
  return status;
}

/** 整个进程只选一次。会话、插件和目录都要等它完成后再碰 Pi 的类。 */
export function ensurePiSdk(): Promise<void> {
  pending ??= selectPiSdk();
  return pending;
}

export function piVersionsCompatible(builtin: string, globalVersion: string): boolean {
  const [builtinMajor, builtinMinor] = builtin.split(".");
  const [globalMajor, globalMinor] = globalVersion.split(".");
  return Boolean(builtinMajor && globalMajor) && builtinMajor === globalMajor && builtinMinor === globalMinor;
}

/** `nodeModulesRoot` 是 `npm root -g` 的结果。包不在或入口解析不了就返回 undefined。 */
export function readGlobalPiPackage(
  nodeModulesRoot: string,
): { version: string; entry: string } | undefined {
  const jsonPath = join(nodeModulesRoot, "@earendil-works", "pi-coding-agent", "package.json");
  if (!existsSync(jsonPath)) return undefined;
  let version = "";
  try {
    const manifest = JSON.parse(readFileSync(jsonPath, "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || !manifest.version) return undefined;
    version = manifest.version;
  } catch {
    return undefined;
  }
  try {
    const entry = createRequire(join(nodeModulesRoot, "..", "package.json")).resolve(
      "@earendil-works/pi-coding-agent",
    );
    return { version, entry };
  } catch {
    return undefined;
  }
}

function readBundledVersion(): string {
  const stamped = (globalThis as { __zcodeBundledPiVersion?: string }).__zcodeBundledPiVersion;
  if (stamped) return stamped;
  try {
    // CJS bundle 里 import.meta.url 是空的。空字符串传给 createRequire 会在模块加载时抛错，
    // --prepare-storage 进程直接退出，Host 只能看到 transport_closed。
    const here = import.meta.url;
    const entry =
      typeof here === "string" && here.length > 0 && typeof import.meta.resolve === "function"
        ? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
        : undefined;
    if (!entry) return "0.0.0";
    const manifest = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return manifest.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function npmGlobalRoot(): string | undefined {
  const bin = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(bin, ["root", "-g"], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const root = result.stdout?.trim();
  return result.status === 0 && root ? root : undefined;
}

function globalNodeModulesRoots(): string[] {
  const roots = [npmGlobalRoot()];
  const prefix = process.env.npm_config_prefix?.trim();
  if (prefix) roots.push(join(prefix, "node_modules"));
  if (process.platform === "win32") {
    if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  } else {
    roots.push(
      "/usr/local/lib/node_modules",
      "/usr/lib/node_modules",
      join(homedir(), ".npm-global/lib/node_modules"),
    );
  }
  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

async function selectPiSdk(): Promise<void> {
  const builtinVersion = status.builtinVersion;
  if (process.env[ZCODE_PI_SDK_ENV_KEY] !== "global") {
    status = { requested: "builtin", active: "builtin", builtinVersion };
    return;
  }
  let found: { version: string; entry: string } | undefined;
  for (const root of globalNodeModulesRoots()) {
    found = readGlobalPiPackage(root);
    if (found) break;
  }
  if (!found) {
    status = { requested: "global", active: "builtin", builtinVersion, reason: "missing" };
    return;
  }
  if (!piVersionsCompatible(builtinVersion, found.version)) {
    status = {
      requested: "global",
      active: "builtin",
      builtinVersion,
      globalVersion: found.version,
      reason: "incompatible",
    };
    return;
  }
  try {
    const loaded = (await import(pathToFileURL(found.entry).href)) as typeof bundledCoding;
    if (
      typeof loaded.createAgentSession !== "function" ||
      typeof loaded.ModelRuntime?.create !== "function"
    ) {
      throw new Error("missing createAgentSession");
    }
    coding = loaded;
    status = {
      requested: "global",
      active: "global",
      builtinVersion,
      globalVersion: found.version,
    };
  } catch {
    status = {
      requested: "global",
      active: "builtin",
      builtinVersion,
      globalVersion: found.version,
      reason: "load-failed",
    };
  }
}
