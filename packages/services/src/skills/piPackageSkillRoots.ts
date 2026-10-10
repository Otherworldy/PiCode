import { ensureAppDataDir } from "@zcode/shared/node";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface PiPackageSkillRoot {
  path: string;
  pluginId: string;
  pluginName: string;
  /** 设置页个人 / 当前工作区。Pi 的 project 包对应 workspace。 */
  scope: "user" | "workspace";
}

/**
 * 已启用 Pi 包声明的技能目录。
 * 只读 settings.json、包清单和 PiCode 插件开关，不安装缺包，也不执行扩展。
 * 因此 `resources_discover` 运行时上报的技能不在这里。
 */
export async function listEnabledPiPackageSkillRoots(input: {
  workspacePath: string;
  includeUserPackages: boolean;
  agentDir?: string;
  switchPath?: string;
}): Promise<PiPackageSkillRoot[]> {
  const agentDir = input.agentDir ?? defaultPiAgentDir();
  const switches = await readSwitches(input.switchPath ?? defaultPiPluginSwitchPath());
  const found: PiPackageSkillRoot[] = [];
  const seen = new Set<string>();
  const scopes: Array<"user" | "project"> = input.includeUserPackages
    ? ["user", "project"]
    : ["project"];
  for (const scope of scopes) {
    const settingsPath =
      scope === "user"
        ? join(agentDir, "settings.json")
        : join(input.workspacePath, ".pi", "settings.json");
    for (const entry of await readPackages(settingsPath)) {
      const source = sourceOf(entry);
      if (!source) continue;
      const pluginId = `pkg:${scope}:${source}`;
      if (!wanted(switches, pluginId, piEnabled(entry)) || disablesAllSkills(entry)) continue;
      const packageRoot = resolvePackageRoot(source, scope, agentDir, input.workspacePath);
      if (!packageRoot || !(await exists(packageRoot))) continue;
      const pluginName = displayName(source);
      const settingsScope = scope === "user" ? "user" : "workspace";
      for (const skillRoot of await skillScanRoots(packageRoot)) {
        const key = `${pluginId}\0${skillRoot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ path: skillRoot, pluginId, pluginName, scope: settingsScope });
      }
    }
  }
  return found;
}

function defaultPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function defaultPiPluginSwitchPath(): string {
  return join(ensureAppDataDir(homedir()), "pi-plugin-switches.json");
}

async function readSwitches(path: string): Promise<Record<string, boolean>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const switches: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("pkg:") && typeof value === "boolean") switches[key] = value;
    }
    return switches;
  } catch {
    return {};
  }
}

async function readPackages(path: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { packages?: unknown };
    return Array.isArray(parsed.packages) ? parsed.packages : [];
  } catch {
    return [];
  }
}

function sourceOf(entry: unknown): string | undefined {
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (!isRecord(entry) || typeof entry.source !== "string" || !entry.source.trim()) return undefined;
  return entry.source.trim();
}

function piEnabled(entry: unknown): boolean {
  return typeof entry === "string" || (isRecord(entry) && entry.autoload !== false);
}

function wanted(switches: Record<string, boolean>, id: string, enabledInPi: boolean): boolean {
  return switches[id] ?? enabledInPi;
}

/** Pi 用空数组表示这个包不贡献该资源。非空过滤模式留给 Pi 自己解释。 */
function disablesAllSkills(entry: unknown): boolean {
  return isRecord(entry) && Array.isArray(entry.skills) && entry.skills.length === 0;
}

function resolvePackageRoot(
  source: string,
  scope: "user" | "project",
  agentDir: string,
  workspacePath: string,
): string | undefined {
  if (source.startsWith("npm:")) {
    const name = npmPackageName(source.slice("npm:".length).trim());
    if (!name) return undefined;
    const modules =
      scope === "project"
        ? join(workspacePath, ".pi", "npm", "node_modules")
        : join(agentDir, "npm", "node_modules");
    return join(modules, name);
  }
  const gitRoot = gitPackageRoot(source, scope, agentDir, workspacePath);
  if (gitRoot) return gitRoot;
  if (/^(?:git|github|https?|ssh):/iu.test(source)) return undefined;
  const base = scope === "project" ? join(workspacePath, ".pi") : agentDir;
  if (source === "~" || source.startsWith("~/") || source.startsWith("~\\")) {
    return join(homedir(), source.slice(2));
  }
  return isAbsolute(source) ? source : resolve(base, source);
}

function npmPackageName(spec: string): string | undefined {
  const match = /^(?<name>@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/u.exec(spec);
  const name = match?.groups?.name?.trim();
  return name || undefined;
}

function gitPackageRoot(
  source: string,
  scope: "user" | "project",
  agentDir: string,
  workspacePath: string,
): string | undefined {
  let raw = source.trim();
  if (raw.startsWith("github:")) raw = `https://github.com/${raw.slice("github:".length)}`;
  else if (raw.startsWith("git:")) raw = raw.slice("git:".length).trim();
  else if (!/^(?:https?|ssh):\/\//iu.test(raw)) return undefined;
  raw = (raw.split("#")[0] ?? raw).replace(/\.git$/iu, "");
  const match = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?<host>[^/:]+)[/:](?<path>.+)$/iu.exec(
    raw,
  );
  const host = match?.groups?.host;
  const repoPath = match?.groups?.path;
  if (!host || !repoPath) return undefined;
  const root = scope === "project" ? join(workspacePath, ".pi", "git") : join(agentDir, "git");
  return join(root, host, repoPath);
}

function displayName(source: string): string {
  const bare = source.replace(/^npm:/u, "");
  return bare.split(/[\\/]/u).at(-1) || bare;
}

async function skillScanRoots(packageRoot: string): Promise<string[]> {
  const manifest = await readPiSkillEntries(packageRoot);
  if (manifest) {
    const roots: string[] = [];
    for (const entry of manifest) {
      if (isOverridePattern(entry) || hasGlob(entry)) continue;
      const root = await asSkillScanRoot(resolve(packageRoot, entry));
      if (root) roots.push(root);
    }
    return roots;
  }
  const convention = await asSkillScanRoot(join(packageRoot, "skills"));
  return convention ? [convention] : [];
}

/** 有 `pi` 字段时只认声明的 skills；没有清单才退回包内 `skills/`。 */
async function readPiSkillEntries(packageRoot: string): Promise<string[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      pi?: unknown;
    };
    if (!isRecord(parsed.pi)) return undefined;
    const entries = parsed.pi.skills;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) return [];
    return entries;
  } catch {
    return undefined;
  }
}

function isOverridePattern(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function hasGlob(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

async function asSkillScanRoot(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return path;
    if (info.isFile() && basename(path) === "SKILL.md") return dirname(path);
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
