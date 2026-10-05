import { homedir } from "node:os";
import { resolve } from "node:path";
import type { LoadedMcpConfig, McpServerConfig, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import {
  StdioTransport,
  StreamableHttpTransport,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import { readPiMcpServers, toPiStoredMcpServer } from "@zcode/shared/node";

const NODE_REPL = "node_repl";

export interface PiMcpRuntimeServer {
  name: string;
  config: Record<string, unknown>;
}

export interface PiMcpCompat {
  runtimeServers(input: { cwd: string; sessionId: string }): Promise<PiMcpRuntimeServer[]>;
  outgoingMeta?(input: {
    serverName: string;
    config: Record<string, unknown>;
    sessionId: string;
  }): Promise<Record<string, unknown> | undefined>;
  officialFetch?(input: {
    serverName: string;
    config: Record<string, unknown>;
  }): typeof fetch | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

/** `${NAME}` from the environment. A leading `!` is left as-is; Pi would shell it. */
function expandValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") record[key] = expandValue(item);
  }
  return record;
}

function isOfficialHttp(config: Record<string, unknown>): boolean {
  return typeof config.url === "string" && isRecord(config.auth) && config.auth.type === "zcode_official";
}

function sessionMeta(sessionId: string): Record<string, unknown> {
  const requestContext = { session_id: sessionId };
  return { ...requestContext, "com.zcode/request-context": requestContext };
}

/** node_repl's SDK speaks the 2026-07-28 envelope. Pi's client stops at 2025-11-25. */
const NODE_REPL_ENVELOPE: Record<string, unknown> = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "zcode", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function wrapMeta(
  inner: McpTransport,
  attach: (message: JsonRpcMessage) => Promise<JsonRpcMessage>,
  answerInitialize = false,
): McpTransport {
  const listeners = new Set<(message: JsonRpcMessage) => void>();
  return {
    start: () => inner.start(),
    close: () => inner.close(),
    send: async (message) => {
      // The 2026 server has no initialize method. Answer Pi locally, then stamp later calls.
      if (answerInitialize && isRequest(message) && message.method === "initialize") {
        const response: JsonRpcMessage = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: NODE_REPL, version: "0" },
          },
        };
        for (const listener of listeners) listener(response);
        return;
      }
      await inner.send(await attach(message));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      const stop = inner.onMessage(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    onError: (listener) => inner.onError(listener),
    onClose: (listener) => inner.onClose(listener),
    setProtocolVersion: inner.setProtocolVersion?.bind(inner),
  };
}

export function loadZcodeMcpConfig(agentDir: string, cwd: string): LoadedMcpConfig {
  const loaded = readPiMcpServers(agentDir, cwd);
  return {
    autoEnableCodemode: true,
    errors: loaded.errors,
    projectConfig: resolve(cwd, ".pi", "mcp.json"),
    servers: loaded.servers.map((server) => ({
      name: server.name,
      config: server.config as unknown as McpServerConfig,
      source: server.scope === "project" ? "project" : "global",
      scope: server.scope,
    })),
  };
}

export function createZcodeMcpTransport(input: {
  compat?: PiMcpCompat;
  sessionId: string;
}): McpTransportFactory {
  return (entry, cwd, authProvider) => {
    const config = entry.config as McpServerConfig & Record<string, unknown>;
    const attach = async (message: JsonRpcMessage): Promise<JsonRpcMessage> => {
      if (!isRequest(message)) return message;
      const extra = await input.compat?.outgoingMeta?.({
        serverName: entry.name,
        config,
        sessionId: input.sessionId,
      });
      const meta = {
        ...(entry.name === NODE_REPL ? NODE_REPL_ENVELOPE : {}),
        ...(entry.name === NODE_REPL ? sessionMeta(input.sessionId) : {}),
        ...extra,
      };
      if (Object.keys(meta).length === 0) return message;
      const params = isRecord(message.params) ? { ...message.params } : {};
      const previous = isRecord(params._meta) ? params._meta : {};
      params._meta = { ...previous, ...meta };
      return { ...message, params };
    };
    if (typeof config.url === "string") {
      const official = isOfficialHttp(config) ? input.compat?.officialFetch?.({ serverName: entry.name, config }) : undefined;
      const transport = new StreamableHttpTransport({
        url: config.url,
        headers: stringRecord(config.headers),
        ...(official ? { fetch: official } : {}),
        ...(official ? {} : { authProvider }),
      });
      return entry.name === NODE_REPL || input.compat?.outgoingMeta ? wrapMeta(transport, attach) : transport;
    }
    const command = typeof config.command === "string" ? config.command : "";
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === "string").map(expandHome)
      : undefined;
    const env = stringRecord(config.env);
    const stdio = new StdioTransport({
      command: expandHome(command),
      ...(args ? { args } : {}),
      cwd: resolve(cwd, expandHome(typeof config.cwd === "string" ? config.cwd : ".")),
      ...(env ? { env } : {}),
      stderr: "pipe",
    });
    return wrapMeta(stdio, attach, entry.name === NODE_REPL);
  };
}

export function registerableMcpServers(
  servers: readonly PiMcpRuntimeServer[],
): Array<{ name: string; config: McpServerConfig }> {
  const registered: Array<{ name: string; config: McpServerConfig }> = [];
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) continue;
    const config = toPiStoredMcpServer(server.config);
    if (!config || config.enabled === false) continue;
    if (typeof config.command !== "string" && typeof config.url !== "string") continue;
    registered.push({ name: server.name, config: config as unknown as McpServerConfig });
  }
  return registered;
}
