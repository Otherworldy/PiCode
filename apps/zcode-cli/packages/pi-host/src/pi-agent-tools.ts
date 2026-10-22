import { pathToFileURL } from "node:url";
import { piLocalToolNames } from "./pi-tool-names.js";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";

/** 子会话拿不到这两个：派发工具不进子会话，同名插件工具在主会话上也被禁用。 */
const NON_SUBAGENT_TOOL_NAMES = new Set(["subagent", "picode_subagent"]);

export interface PiAgentToolEntry {
  name: string;
  source: "builtin" | "extension";
}

export interface PiAgentExtensionTools {
  /** `file://` URL，可直接作为 `additionalExtensionPaths` 使用。 */
  path: string;
  tools: string[];
}

function isChildToolName(name: string): boolean {
  return !name.startsWith("mcp__") && !NON_SUBAGENT_TOOL_NAMES.has(name);
}

/**
 * 和 `runZcodeSubagent` 用同一套 loader 配置扫描 Pi 包扩展：
 * 读文件里的 Pi 设置（global / project 两个 scope 的 `packages` 都算），
 * 不注册 codemode / tool-search / MCP 三个内置扩展工厂。
 */
async function scanPiExtensions(cwd: string, agentDir?: string): Promise<PiAgentExtensionTools[]> {
  await ensurePiSdk();
  const { DefaultResourceLoader, SettingsManager } = piCoding();
  const dir = agentDir ?? piCoding().getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: dir,
    settingsManager: SettingsManager.create(cwd, dir),
    noSkills: true,
  });
  await loader.reload();
  return loader
    .getExtensions()
    .extensions.map((extension) => ({
      path: pathToFileURL(extension.path).href,
      tools: [...extension.tools.keys()].filter(isChildToolName),
    }))
    .filter((extension) => extension.tools.length > 0);
}

/** 每个扩展注册的工具名。子会话按角色需要的工具反查要加载哪几个扩展。 */
export async function listPiAgentExtensions(
  cwd: string,
  agentDir?: string,
): Promise<PiAgentExtensionTools[]> {
  return scanPiExtensions(cwd, agentDir);
}

/**
 * 子会话可用的工具清单：Pi 内置工具 + 用户 Pi 包扩展注册的工具。
 *
 * 设置页没有活动会话也要能出清单，所以按 workspace 现扫，不读会话快照。
 */
export async function listPiAgentTools(
  cwd: string,
  agentDir?: string,
): Promise<PiAgentToolEntry[]> {
  const entries: PiAgentToolEntry[] = piLocalToolNames().map((name) => ({
    name,
    source: "builtin" as const,
  }));
  const seen = new Set(entries.map((entry) => entry.name));
  for (const extension of await scanPiExtensions(cwd, agentDir)) {
    for (const name of extension.tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({ name, source: "extension" });
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
