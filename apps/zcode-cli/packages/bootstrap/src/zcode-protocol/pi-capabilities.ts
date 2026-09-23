import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { normalizeAgentProfiles, toMcpToolName } from "@zcode/core";
import {
  createTraceId,
  type McpServerConfig,
  type McpToolCallResult,
  type SessionId,
} from "@zcode/contracts";
import type { PiCapabilityPorts } from "@zcode/pi-host";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";
import { resolveHostBrowserCapability } from "../app/built-in-node-repl.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "../app/node-repl-browser-broker.js";
import { loadZCodeAgentProfiles } from "../subagents.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
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
    const raw = JSON.parse(readFileSync(join(home, ".zcode", "v2", "setting.json"), "utf8")) as {
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

function enabledServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => server.enabled !== false),
  );
}

function formatMcpToolList(tools: Array<{ toolName: string; description?: string }>): string {
  // ponytail: no metadata cache. Search connects the named server, then filters in memory.
  const shown = tools.slice(0, 30);
  const lines = shown.map((tool) =>
    tool.description ? `${tool.toolName}: ${tool.description}` : tool.toolName,
  );
  if (tools.length > shown.length) lines.push(`…${tools.length - shown.length} more. Narrow search.`);
  return lines.join("\n");
}

function mcpToolRequest(input: {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  cwd?: string;
  sessionId?: string;
}) {
  return {
    serverName: input.serverName,
    toolName: input.toolName,
    arguments: input.arguments,
    runtimeScope: "main" as const,
    ...(input.cwd ? { workspacePath: input.cwd } : {}),
    ...(input.sessionId
      ? {
          trace: {
            traceId: createTraceId(),
            sessionId: input.sessionId as SessionId,
          },
        }
      : {}),
  };
}

function mcpResultText(result: McpToolCallResult): string {
  const text = result.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((line) => line.trim().length > 0)
    .join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return "";
}

function readMcpServers(
  context: ZCodeProtocolAgentServerContext,
  workspacePath: string,
  mcpServers?: ZCodeProtocolMcpServer[],
): Record<string, McpServerConfig> {
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory: workspacePath,
  });
  const fromFile = configResult.config.mcp?.servers ?? {};
  const fromPayload = protocolMcpServersToRuntimeMcpConfig(mcpServers)?.servers ?? {};
  const host = ensureHostBrowser(context, workspacePath);
  return enabledServers({
    ...fromFile,
    ...fromPayload,
    ...(host ? { [HOST_BROWSER_SERVER]: host.server } : {}),
  });
}

export async function connectZCodeMcp(
  context: ZCodeProtocolAgentServerContext,
  input: { workspacePath: string; mcpServers?: ZCodeProtocolMcpServer[] },
): Promise<void> {
  const mcpPort = context.deps.mcpPort;
  if (!mcpPort) return;
  const servers = readMcpServers(context, input.workspacePath, input.mcpServers);
  if (hostBrowserBroker) await hostBrowserBroker.ready.catch(() => undefined);
  for (const [name, server] of Object.entries(servers)) {
    if (server.directTools !== true) continue;
    try {
      await mcpPort.connectServer(name, server, { workingDirectory: input.workspacePath });
    } catch (error) {
      context.logger?.warn("ZCode MCP direct tool connect failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.mcp_connect_failed",
        server: name,
        workspacePath: input.workspacePath,
      });
    }
  }
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
      // ponytail: plugin-packaged agents stay on the settings page only.
      return normalizeAgentProfiles(loaded.profiles, {
        builtInModelSelectionOverrides: loaded.builtInModelSelectionOverrides,
      }).map((profile) => ({
        name: profile.name,
        description: profile.description,
        systemPrompt: profile.systemPrompt,
        ...(profile.tools ? { tools: profile.tools } : {}),
      }));
    },
    async listMcpTools(cwd) {
      const context = getContext();
      const mcpPort = context.deps.mcpPort;
      if (!mcpPort) return [];
      const direct = new Set(
        Object.entries(readMcpServers(context, cwd))
          .filter(([, server]) => server.directTools === true)
          .map(([name]) => name),
      );
      if (direct.size === 0) return [];
      const tools = await mcpPort.listTools();
      return tools
        .filter((tool) => direct.has(tool.serverName))
        .map((tool) => ({
          name: toMcpToolName(tool),
          ...(tool.description ? { description: tool.description } : {}),
          serverName: tool.serverName,
          toolName: tool.toolName,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? (tool.inputSchema as Record<string, unknown>)
              : {},
        }));
    },
    async useMcp(input) {
      const context = getContext();
      const servers = readMcpServers(context, input.cwd);
      const names = Object.keys(servers).sort();
      if (!input.server && !input.tool && !input.describe && input.search === undefined) {
        return {
          text:
            names.length === 0
              ? "No MCP servers configured."
              : names
                  .map((name) => `${name}${servers[name]?.directTools === true ? " (direct)" : ""}`)
                  .join("\n"),
        };
      }
      const serverName = input.server?.trim() ?? "";
      const server = servers[serverName];
      if (!server) {
        return {
          text: `Unknown MCP server "${serverName}". Available: ${names.join(", ") || "(none)"}`,
          isError: true,
        };
      }
      const mcpPort = context.deps.mcpPort;
      if (!mcpPort) return { text: "MCP is not available", isError: true };
      try {
        await mcpPort.connectServer(serverName, server, { workingDirectory: input.cwd });
        const tools = (await mcpPort.listTools()).filter((tool) => tool.serverName === serverName);
        if (input.tool) {
          const match = tools.find(
            (tool) => tool.toolName === input.tool || tool.name === input.tool,
          );
          if (!match) {
            return {
              text: `Unknown tool "${input.tool}" on ${serverName}. ${formatMcpToolList(tools)}`,
              isError: true,
            };
          }
          const result = await mcpPort.callTool(
            mcpToolRequest({
              serverName,
              toolName: match.toolName,
              arguments: input.args,
              cwd: input.cwd,
              sessionId: input.sessionId,
            }),
            { signal: input.signal },
          );
          return { text: mcpResultText(result), isError: result.isError === true };
        }
        if (input.describe) {
          const match = tools.find(
            (tool) => tool.toolName === input.describe || tool.name === input.describe,
          );
          if (!match) {
            return {
              text: `Unknown tool "${input.describe}" on ${serverName}. ${formatMcpToolList(tools)}`,
              isError: true,
            };
          }
          return {
            text: `${match.toolName}: ${match.description ?? ""}\n${JSON.stringify(match.inputSchema ?? {})}`,
          };
        }
        const query = (input.search ?? "").trim().toLowerCase();
        const matched = tools.filter((tool) => {
          if (!query) return true;
          return (
            tool.toolName.toLowerCase().includes(query) ||
            (tool.description ?? "").toLowerCase().includes(query)
          );
        });
        return { text: formatMcpToolList(matched) || `No tools match "${query}".` };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
    async callMcpTool(input) {
      const mcpPort = getContext().deps.mcpPort;
      if (!mcpPort) return { text: "MCP is not available", isError: true };
      try {
        const result = await mcpPort.callTool(
          mcpToolRequest({
            serverName: input.serverName,
            toolName: input.toolName,
            arguments: input.arguments,
            sessionId: input.sessionId,
          }),
          { signal: input.signal },
        );
        return { text: mcpResultText(result), isError: result.isError === true };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}
