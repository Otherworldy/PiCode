import { relative } from "node:path";
import type {
  DefaultPackageManager,
  PackageSource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";

export type PiPluginKind = "package" | "extension";
export type PiPluginScope = "user" | "project";

export type PiPluginView = {
  id: string;
  kind: PiPluginKind;
  name: string;
  detail: string;
  scope: PiPluginScope;
  enabled: boolean;
};

function sourceOf(pkg: PackageSource): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function enabledOf(pkg: PackageSource): boolean {
  return typeof pkg === "string" || pkg.autoload !== false;
}

function displayName(source: string): string {
  const bare = source.replace(/^npm:/, "");
  const parts = bare.split(/[\\/]/);
  return parts.at(-1) || bare;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function packagesOf(settings: SettingsManager, scope: PiPluginScope): PackageSource[] {
  const file = scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
  return file.packages ?? [];
}

function patternsOf(settings: SettingsManager, scope: PiPluginScope): string[] {
  const file = scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
  return file.extensions ?? [];
}

export async function listPiPlugins(cwd: string, agentDir?: string): Promise<PiPluginView[]> {
  await ensurePiSdk();
  const { DefaultPackageManager: PackageManager, SettingsManager, getAgentDir } = piCoding();
  const dir = agentDir ?? getAgentDir();
  const settings = SettingsManager.create(cwd, dir);
  const packages = new PackageManager({ cwd, agentDir: dir, settingsManager: settings });
  const rows: PiPluginView[] = [];
  for (const pkg of packages.listConfiguredPackages()) {
    const listed = packagesOf(settings, pkg.scope).find((item) => sourceOf(item) === pkg.source);
    rows.push({
      id: `pkg:${pkg.scope}:${pkg.source}`,
      kind: "package",
      name: displayName(pkg.source),
      detail: pkg.source,
      scope: pkg.scope,
      enabled: listed ? enabledOf(listed) : true,
    });
  }
  let extensions: Awaited<ReturnType<DefaultPackageManager["resolve"]>>["extensions"] = [];
  try {
    extensions = (await packages.resolve(async () => "skip")).extensions;
  } catch {
    extensions = [];
  }
  for (const ext of extensions) {
    if (ext.metadata.origin !== "top-level" || ext.metadata.source !== "auto") continue;
    if (ext.metadata.scope !== "user" && ext.metadata.scope !== "project") continue;
    const rel = ext.metadata.baseDir
      ? toPosix(relative(ext.metadata.baseDir, ext.path))
      : toPosix(ext.path);
    rows.push({
      id: `ext:${ext.metadata.scope}:${rel}`,
      kind: "extension",
      name: displayName(ext.path),
      detail: rel,
      scope: ext.metadata.scope,
      enabled: ext.enabled,
    });
  }
  rows.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return rows;
}

function withoutAutoload(pkg: Exclude<PackageSource, string>, source: string): PackageSource {
  const { autoload: _autoload, ...rest } = pkg;
  return Object.keys(rest).length === 1 ? source : { ...rest, autoload: true };
}

export async function setPiPluginEnabled(
  cwd: string,
  id: string,
  enabled: boolean,
  agentDir?: string,
): Promise<void> {
  await ensurePiSdk();
  const { SettingsManager, getAgentDir } = piCoding();
  const settings = SettingsManager.create(cwd, agentDir ?? getAgentDir());
  const [kind, scope, ...rest] = id.split(":");
  const key = rest.join(":");
  if ((scope !== "user" && scope !== "project") || !key) {
    throw new Error(`Unknown Pi plugin "${id}"`);
  }
  if (scope === "project") settings.setProjectTrusted(true);
  if (kind === "pkg") {
    const next = packagesOf(settings, scope).map((pkg) => {
      if (sourceOf(pkg) !== key) return pkg;
      if (enabled) return typeof pkg === "string" ? pkg : withoutAutoload(pkg, key);
      return typeof pkg === "string" ? { source: key, autoload: false } : { ...pkg, autoload: false };
    });
    if (scope === "project") settings.setProjectPackages(next);
    else settings.setPackages(next);
  } else if (kind === "ext") {
    const marker = `-${key}`;
    const current = patternsOf(settings, scope);
    const next = enabled
      ? current.filter((pattern) => pattern !== marker && pattern !== `!${key}`)
      : current.includes(marker)
        ? current
        : [...current, marker];
    if (scope === "project") settings.setProjectExtensionPaths(next);
    else settings.setExtensionPaths(next);
  } else {
    throw new Error(`Unknown Pi plugin "${id}"`);
  }
  await settings.flush();
}
