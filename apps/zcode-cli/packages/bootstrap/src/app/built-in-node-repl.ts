import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type Logger, type McpServerConfig, type PluginLoadOutcome } from "@zcode/contracts";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "./official-plugin-definitions.js";

const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";

/**
 * node_repl 是官方能力共用的宿主工具，不是任何插件 manifest 声明的 plugin MCP。产物由独立的
 * `node-repl-host` seed 单元携带（无 listing、不对用户露出）；Browser Use 与 Computer Use
 * 各自只贡献自己的 skill、docs 与 native 依赖 root。
 */
export function resolveBuiltInNodeReplMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const browserUsePackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePackage && !cuaPackage) return {};
  // 宿主自己不参与启用判断：它没有 skill、不对用户露出，缺失就意味着没有宿主可跑，
  // 必须安全地不注册，而不是回退到某个插件包里的旧产物。
  const hostPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  );
  if (!hostPackage) return {};

  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: {
      // 领域 root 各自注入，且只在对应能力启用时注入：宿主据此决定哪一半文档可用。
      ...(browserUsePackage ? { ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath } : {}),
      ...(cuaPackage ? { ZCODE_CUA_PLUGIN_ROOT: cuaPackage.rootPath } : {}),
    },
    rootPath: hostPackage.rootPath,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return {};
  return {
    [BUILT_IN_NODE_REPL_SERVER_NAME]: {
      ...nodeRepl,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
  };
}

function seededRoot(storageRoot: string, name: string): string | undefined {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name);
  if (!definition) return undefined;
  const root = join(
    storageRoot,
    "cache",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
  return existsSync(join(root, ".zcode-plugin", "plugin.json")) ? root : undefined;
}

/** 浏览器是宿主能力。不看插件启用开关，只要打包产物在就连 node_repl。 */
export function resolveHostBrowserCapability(input: {
  logger?: Logger;
  storageRoot: string;
  workingDirectory: string;
}): { server: McpServerConfig; skillPath: string } | undefined {
  // 成功的 seed 不会出现在返回值里，调用只为了把当前版本写入 cache。
  resolveOfficialPluginRoots({
    logger: input.logger,
    storageRoot: input.storageRoot,
  });
  const browserRoot = seededRoot(input.storageRoot, "browser-use");
  const hostRoot = seededRoot(input.storageRoot, "node-repl-host");
  if (!browserRoot || !hostRoot) return undefined;
  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: { ZCODE_PLUGIN_ROOT: browserRoot },
    rootPath: hostRoot,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return undefined;
  return {
    server: {
      ...nodeRepl,
      directTools: true,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
    skillPath: join(browserRoot, "skills", "control-browser", "SKILL.md"),
  };
}
