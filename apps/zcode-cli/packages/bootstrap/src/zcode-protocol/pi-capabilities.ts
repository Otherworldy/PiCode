import { ensureAppDataDir } from "@zcode/shared/node";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { normalizeAgentProfiles } from "@zcode/core";
import { type Logger, type McpServerConfig } from "@zcode/contracts";
import type { PiCapabilityPorts } from "@zcode/pi-host";
import { resolveHostBrowserCapability } from "../app/built-in-node-repl.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "../app/node-repl-browser-broker.js";
import { loadZCodeAgentProfiles } from "../subagents.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

const HOST_BROWSER_SERVER = "node_repl";
let hostBrowserBroker: NodeReplBrowserBroker | undefined;
let hostBrowserServer: McpServerConfig | undefined;
let hostBrowserSkillPath: string | undefined;
let hostBrowserStorageRoot: string | undefined;

function pluginStorageRoot(context: ZCodeProtocolAgentServerContext, cwd: string): string {
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory: cwd,
  });
  return getPluginStorageRoot(getCliStorageRoot(resolvePath(configResult.config.storage.dir)));
}

export function readBrowserHostEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const home =
    env?.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    env?.HOME?.trim() ||
    env?.USERPROFILE?.trim() ||
    homedir();
  try {
    const raw = JSON.parse(readFileSync(join(ensureAppDataDir(home), "v2", "setting.json"), "utf8")) as {
      browserHostEnabled?: unknown;
    };
    return raw.browserHostEnabled !== false;
  } catch {
    return true;
  }
}

function ensureHostBrowser(
  context: ZCodeProtocolAgentServerContext,
  cwd: string,
): { server: McpServerConfig; skillPath: string } | undefined {
  if (!readBrowserHostEnabled(context.deps.env)) return undefined;
  const port = context.browserControlPort;
  const logger = context.logger;
  if (!port || !logger) return undefined;
  const storageRoot = pluginStorageRoot(context, cwd);
  if (hostBrowserServer && hostBrowserSkillPath && hostBrowserStorageRoot === storageRoot) {
    return { server: hostBrowserServer, skillPath: hostBrowserSkillPath };
  }
  const resolved = resolveHostBrowserCapability({
    logger,
    storageRoot,
    workingDirectory: cwd,
  });
  if (!resolved) {
    logger.warn?.("host browser capability unavailable", { storageRoot });
    return undefined;
  }
  hostBrowserBroker ??= createNodeReplBrowserBroker({
    browserControlPort: port,
    logger,
    platform: context.deps.platform,
  });
  hostBrowserServer = injectNodeReplBrowserBroker(
    { [HOST_BROWSER_SERVER]: resolved.server },
    hostBrowserBroker,
  )[HOST_BROWSER_SERVER];
  hostBrowserSkillPath = resolved.skillPath;
  hostBrowserStorageRoot = storageRoot;
  return hostBrowserServer
    ? { server: hostBrowserServer, skillPath: hostBrowserSkillPath }
    : undefined;
}

export function hostBrowserSkillPaths(
  context: ZCodeProtocolAgentServerContext,
  cwd: string,
): string[] {
  const host = ensureHostBrowser(context, cwd);
  return host ? [host.skillPath] : [];
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
} as unknown as Logger;

/** Plugin MCP and the built-in browser server. User servers are read from Pi mcp.json. */
export async function piRuntimeMcpServers(
  context: ZCodeProtocolAgentServerContext,
  cwd: string,
): Promise<Array<{ name: string; config: Record<string, unknown> }>> {
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory: cwd,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer: new StartupTimer(
      context.logger ?? noopLogger,
      { module: "bootstrap.pi_mcp", workspacePath: cwd },
      startupNow(),
    ),
    workingDirectory: cwd,
  });
  const host = ensureHostBrowser(context, cwd);
  if (hostBrowserBroker) await hostBrowserBroker.ready.catch(() => undefined);
  const servers: Record<string, McpServerConfig> = {
    ...pluginOutcome.mcpServers,
    ...(host ? { [HOST_BROWSER_SERVER]: host.server } : {}),
  };
  return Object.entries(servers)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, config]) => ({ name, config: { ...config } }));
}

export function createPiCapabilityPorts(
  getContext: () => ZCodeProtocolAgentServerContext,
): PiCapabilityPorts {
  return {
    async listSubagents(cwd) {
      const context = getContext();
      const configResult = createConfig({
        env: context.deps.env,
        workingDirectory: cwd,
      });
      const loaded = await loadZCodeAgentProfiles({
        logger: context.logger,
        storageRoot: resolvePath(configResult.config.storage.dir),
        workingDirectory: cwd,
      });
      return normalizeAgentProfiles(loaded.profiles, {
        builtInModelSelectionOverrides: loaded.builtInModelSelectionOverrides,
      }).map((profile) => ({
        name: profile.name,
        description: profile.description,
        systemPrompt: profile.systemPrompt,
        ...(profile.tools ? { tools: profile.tools } : {}),
      }));
    },
  };
}
