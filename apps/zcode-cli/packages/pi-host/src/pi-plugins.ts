import { ensureAppDataDir } from "@zcode/shared/node";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

/** 已启用的 `@plannotator/pi-extension`。计划模式只认这个插件。 */
export function isPlannotatorPiExtension(
  plugin: Pick<PiPluginView, "id" | "detail" | "name" | "enabled">,
): boolean {
  if (!plugin.enabled) return false;
  const hay = `${plugin.id}\n${plugin.detail}\n${plugin.name}`.toLowerCase();
  return hay.includes("@plannotator/pi-extension") || hay.includes("plannotator/pi-extension");
}

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

export type ZcodePluginSessionPlan = {
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  disabled: Set<string>;
};

type PluginSourceInfo = {
  origin: string;
  source: string;
  scope: string;
  baseDir?: string;
};

function switchPath(root?: string): string {
  return join(root ?? join(ensureAppDataDir(homedir())), "pi-plugin-switches.json");
}

async function readSwitches(root?: string): Promise<Record<string, boolean>> {
  try {
    const raw = JSON.parse(await readFile(switchPath(root), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const switches: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      if ((key.startsWith("pkg:") || key.startsWith("ext:")) && typeof value === "boolean") {
        switches[key] = value;
      }
    }
    return switches;
  } catch {
    return {};
  }
}

function wanted(switches: Record<string, boolean>, id: string, piEnabled: boolean): boolean {
  return switches[id] ?? piEnabled;
}

export function zcodePluginSourceId(info: PluginSourceInfo, path: string): string | undefined {
  if (info.scope !== "user" && info.scope !== "project") return undefined;
  if (info.origin === "package") return `pkg:${info.scope}:${info.source}`;
  if (info.origin !== "top-level" || info.source !== "auto" || !info.baseDir) return undefined;
  return `ext:${info.scope}:${toPosix(relative(info.baseDir, path))}`;
}

async function resourcePaths(
  root: string,
  field: "extensions" | "skills" | "prompts",
): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      pi?: Record<string, unknown>;
    };
    const entries = pkg.pi?.[field];
    if (Array.isArray(entries)) {
      return entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => resolve(root, entry));
    }
  } catch {
    // 没有 package.json 时按目录补。
  }
  const dir = join(root, field);
  return existsSync(dir) ? [dir] : [];
}

export async function listPiPlugins(
  cwd: string,
  agentDir?: string,
  switchRoot?: string,
): Promise<PiPluginView[]> {
  return (await inspectPiPlugins(cwd, agentDir, switchRoot)).rows;
}

export async function zcodePluginLoaderExtras(
  cwd: string,
  agentDir: string,
  skillPaths: string[],
): Promise<{
  plan: ZcodePluginSessionPlan;
  loader: {
    additionalSkillPaths: string[];
    additionalExtensionPaths?: string[];
    additionalPromptTemplatePaths?: string[];
  };
}> {
  const plan = await planZcodePluginSession(cwd, agentDir);
  return {
    plan,
    loader: {
      additionalSkillPaths: [...skillPaths, ...plan.skillPaths],
      ...(plan.extensionPaths.length > 0 ? { additionalExtensionPaths: plan.extensionPaths } : {}),
      ...(plan.promptPaths.length > 0 ? { additionalPromptTemplatePaths: plan.promptPaths } : {}),
    },
  };
}

export async function planZcodePluginSession(
  cwd: string,
  agentDir?: string,
  switchRoot?: string,
): Promise<ZcodePluginSessionPlan> {
  return (await inspectPiPlugins(cwd, agentDir, switchRoot)).plan;
}

async function inspectPiPlugins(cwd: string, agentDir?: string, switchRoot?: string) {
  await ensurePiSdk();
  const { DefaultPackageManager: PackageManager, SettingsManager, getAgentDir } = piCoding();
  const dir = agentDir ?? getAgentDir();
  const settings = SettingsManager.create(cwd, dir);
  const packages = new PackageManager({ cwd, agentDir: dir, settingsManager: settings });
  const switches = await readSwitches(switchRoot);
  const rows: PiPluginView[] = [];
  const plan: ZcodePluginSessionPlan = {
    extensionPaths: [],
    skillPaths: [],
    promptPaths: [],
    disabled: new Set<string>(),
  };
  const seen = new Set<string>();
  for (const pkg of packages.listConfiguredPackages()) {
    const listed = packagesOf(settings, pkg.scope).find((item) => sourceOf(item) === pkg.source);
    const id = `pkg:${pkg.scope}:${pkg.source}`;
    const piEnabled = listed ? enabledOf(listed) : true;
    const enabled = wanted(switches, id, piEnabled);
    seen.add(id);
    if (switches[id] === false) plan.disabled.add(id);
    if (switches[id] === true && !piEnabled && pkg.installedPath) {
      plan.extensionPaths.push(...(await resourcePaths(pkg.installedPath, "extensions")));
      plan.skillPaths.push(...(await resourcePaths(pkg.installedPath, "skills")));
      plan.promptPaths.push(...(await resourcePaths(pkg.installedPath, "prompts")));
    }
    rows.push({
      id,
      kind: "package",
      name: displayName(pkg.source),
      detail: pkg.source,
      scope: pkg.scope,
      enabled,
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
    const id = `ext:${ext.metadata.scope}:${rel}`;
    const enabled = wanted(switches, id, ext.enabled);
    seen.add(id);
    if (switches[id] === false) plan.disabled.add(id);
    if (switches[id] === true && !ext.enabled) plan.extensionPaths.push(ext.path);
    rows.push({
      id,
      kind: "extension",
      name: displayName(ext.path),
      detail: rel,
      scope: ext.metadata.scope,
      enabled,
    });
  }
  for (const [id, enabled] of Object.entries(switches)) {
    if (!enabled || seen.has(id) || !id.startsWith("ext:")) continue;
    const [, scope, ...rest] = id.split(":");
    if ((scope !== "user" && scope !== "project") || rest.length === 0) continue;
    const base = scope === "project" ? join(cwd, ".pi") : dir;
    const file = join(base, ...rest.join(":").split("/"));
    if (existsSync(file)) plan.extensionPaths.push(file);
  }
  rows.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return { rows, plan };
}

export function applyZcodePluginPlan(
  loader: {
    getExtensions(): { extensions: Array<{ path: string; sourceInfo: PluginSourceInfo }> };
    getSkills(): { skills: Array<{ filePath: string; sourceInfo: PluginSourceInfo }> };
    getPrompts(): { prompts: Array<{ filePath: string; sourceInfo: PluginSourceInfo }> };
  },
  plan: ZcodePluginSessionPlan,
): void {
  const keep = (info: PluginSourceInfo, path: string) => {
    const id = zcodePluginSourceId(info, path);
    return !id || !plan.disabled.has(id);
  };
  const extensions = loader.getExtensions().extensions;
  const skills = loader.getSkills().skills;
  const prompts = loader.getPrompts().prompts;
  const nextExtensions = extensions.filter((item) => keep(item.sourceInfo, item.path));
  const nextSkills = skills.filter((item) => keep(item.sourceInfo, item.filePath));
  const nextPrompts = prompts.filter((item) => keep(item.sourceInfo, item.filePath));
  extensions.splice(0, extensions.length, ...nextExtensions);
  skills.splice(0, skills.length, ...nextSkills);
  prompts.splice(0, prompts.length, ...nextPrompts);
}

export function piPluginPackageSource(id: string): { scope: PiPluginScope; source: string } {
  const match = /^pkg:(user|project):(.+)$/u.exec(id);
  const scope = match?.[1];
  const source = match?.[2];
  if ((scope !== "user" && scope !== "project") || !source) {
    throw new Error(`Pi plugin "${id}" cannot be updated`);
  }
  return { scope, source };
}

type PackageCommandSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const WINDOWS_SHELL_COMMAND = /^(?:npm|pnpm|bun)(?:\.(?:cmd|exe))?$/iu;

function needsWindowsShell(command: string): boolean {
  if (process.platform !== "win32") return false;
  const base = command.slice(Math.max(command.lastIndexOf("\\"), command.lastIndexOf("/")) + 1);
  return WINDOWS_SHELL_COMMAND.test(base) || /\.(?:cmd|bat)$/iu.test(base);
}

function quoteCmdArg(arg: string): string {
  return /[\s"&|<>^]/u.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/**
 * Pi `PackageManager.update` 默认 `stdio: "inherit"`。
 * app-server 的 stdout 是协议帧，npm 打出 `changed 1 package` 会让 Host 解析失败并关掉 Agent。
 * 只换掉这次检查/更新用的实例，让子进程丢掉输出；Windows 的 npm shim 仍走 shell。
 */
export function silencePackageManagerStdout(
  manager: object,
  spawnImpl: PackageCommandSpawn = spawn,
): void {
  const target = manager as {
    spawnCommand?: (command: string, args: string[], options?: { cwd?: string }) => ChildProcess;
  };
  target.spawnCommand = (command, args, options) => {
    const shell = needsWindowsShell(command);
    return spawnImpl(shell ? quoteCmdArg(command) : command, shell ? args.map(quoteCmdArg) : args, {
      cwd: options?.cwd,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
      shell,
    });
  };
}

async function openPackageManager(cwd: string, agentDir?: string) {
  await ensurePiSdk();
  const { DefaultPackageManager: PackageManager, SettingsManager, getAgentDir } = piCoding();
  const dir = agentDir ?? getAgentDir();
  const settings = SettingsManager.create(cwd, dir);
  const packages = new PackageManager({ cwd, agentDir: dir, settingsManager: settings });
  silencePackageManagerStdout(packages);
  return packages;
}

export async function checkPiPluginUpdates(cwd: string, agentDir?: string) {
  const packages = await openPackageManager(cwd, agentDir);
  const found = await packages.checkForAvailableUpdates();
  return found
    .filter((item) => item.scope === "user" || item.scope === "project")
    .map((item) => ({
      id: `pkg:${item.scope}:${item.source}`,
      source: item.source,
      scope: item.scope,
      name: item.displayName,
    }));
}

export async function updatePiPlugin(cwd: string, id: string, agentDir?: string): Promise<void> {
  const { source } = piPluginPackageSource(id);
  const packages = await openPackageManager(cwd, agentDir);
  await packages.update(source);
}

export async function setPiPluginEnabled(
  cwd: string,
  id: string,
  enabled: boolean,
  agentDir?: string,
  switchRoot?: string,
): Promise<void> {
  void cwd;
  void agentDir;
  const [kind, scope, ...rest] = id.split(":");
  if (
    (kind !== "pkg" && kind !== "ext") ||
    (scope !== "user" && scope !== "project") ||
    rest.length === 0
  ) {
    throw new Error(`Unknown Pi plugin "${id}"`);
  }
  const switches = await readSwitches(switchRoot);
  switches[id] = enabled;
  const file = switchPath(switchRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(switches, null, 2)}\n`);
}
