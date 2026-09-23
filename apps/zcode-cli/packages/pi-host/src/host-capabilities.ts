import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { gateTool, type ToolPermissionCheck } from "./permission-gate.js";

export interface ZcodeSubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface ZcodeMcpTool {
  name: string;
  description?: string;
  serverName: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
}

export interface PiMcpRequest {
  cwd: string;
  server?: string;
  search?: string;
  describe?: string;
  tool?: string;
  args?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface PiCapabilityPorts {
  listSubagents(cwd: string): Promise<ZcodeSubagentProfile[]>;
  /** 只返回 directTools 服务器上、已经连接的工具。 */
  listMcpTools(cwd: string): Promise<ZcodeMcpTool[]>;
  callMcpTool(input: {
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; isError?: boolean }>;
  /** 代理：列服务器不连接；搜索、描述、调用才连接指定服务器。 */
  useMcp(input: PiMcpRequest): Promise<{ text: string; isError?: boolean }>;
}

const PI_TOOL_ALIASES: Record<string, readonly string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["find", "ls"],
  find: ["find"],
  ls: ["ls"],
  bash: ["bash", "powershell"],
  edit: ["edit"],
  write: ["write"],
};

export function piToolNamesForAgent(
  tools: readonly string[] | undefined,
  available: readonly string[],
): string[] {
  if (!tools || tools.length === 0 || tools.some((name) => name.trim() === "*")) return [...available];
  const allowed = new Set<string>();
  for (const name of tools) {
    for (const mapped of PI_TOOL_ALIASES[name.trim().toLowerCase()] ?? []) allowed.add(mapped);
  }
  return available.filter((name) => allowed.has(name));
}

type CodingTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: never,
  ) => Promise<unknown>;
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function tool<T extends Record<string, unknown>>(definition: {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: T,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>;
}) {
  return definition;
}

function assistantText(messages: readonly { role?: string; content?: unknown }[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const record = block as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
        chunks.push(record.text.trim());
      }
    }
  }
  return chunks.join("\n");
}

function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === "object" ? schema : { type: "object", properties: {} };
}

export async function runZcodeSubagent(input: {
  cwd: string;
  parentSessionFile: string;
  profile: ZcodeSubagentProfile;
  task: string;
  signal?: AbortSignal;
  modelRuntime: CreateAgentSessionOptions["modelRuntime"];
  model?: CreateAgentSessionOptions["model"];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  agentDir: string;
  codingTools: readonly CodingTool[];
}): Promise<string> {
  if (input.signal?.aborted) return "subagent cancelled";
  const allowed = new Set(piToolNamesForAgent(input.profile.tools, input.codingTools.map((tool) => tool.name)));
  const childDir = join(
    dirname(input.parentSessionFile),
    basename(input.parentSessionFile, ".jsonl"),
    "zcode-subagent",
  );
  await mkdir(childDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    noExtensions: true,
    noSkills: true,
    appendSystemPrompt: [input.profile.systemPrompt || input.profile.description].filter(
      (line) => line.trim().length > 0,
    ),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: input.modelRuntime,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    noTools: "builtin",
    customTools: input.codingTools.filter((tool) => allowed.has(tool.name)) as never,
    resourceLoader: loader,
    sessionManager: SessionManager.create(input.cwd, childDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  const onAbort = () => {
    void session.abort();
  };
  input.signal?.addEventListener("abort", onAbort);
  try {
    await session.prompt(input.task);
    return assistantText(session.messages as { role?: string; content?: unknown }[]) || "(no response)";
  } catch (error) {
    return `subagent failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    session.dispose();
  }
}

export async function createCapabilityTools(input: {
  cwd: string;
  ports: PiCapabilityPorts;
  check?: ToolPermissionCheck;
  reservedNames: readonly string[];
  sessionId?: string;
  runSubagent: (profile: ZcodeSubagentProfile, task: string, signal?: AbortSignal) => Promise<string>;
}) {
  const reserved = new Set(input.reservedNames);
  const agents = await input.ports.listSubagents(input.cwd).catch(() => []);
  const catalog =
    agents.length > 0
      ? agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")
      : "- general-purpose\n- Explore";
  const subagent = tool<{ agent?: string; task?: string }>({
    name: "zcode_subagent",
    label: "Subagent",
    description: `Run a ZCode subagent and return its final answer.\n${catalog}`,
    promptSnippet: "Delegate a task to a ZCode subagent",
    promptGuidelines: [
      "Use zcode_subagent for work that should run in a separate agent. Pick a name from the tool description.",
    ],
    parameters: {
      type: "object",
      required: ["agent", "task"],
      properties: {
        agent: { type: "string", description: "Agent name" },
        task: { type: "string", description: "Complete task for that agent" },
      },
    },
    execute: async (_toolCallId, params, signal) => {
      const agent = String(params.agent ?? "").trim();
      const task = String(params.task ?? "").trim();
      await gateTool(input.check, "zcode_subagent", params);
      const profiles = await input.ports.listSubagents(input.cwd).catch(() => agents);
      const profile = profiles.find((item) => item.name === agent);
      if (!profile) {
        const names = profiles.map((item) => item.name).join(", ") || "general-purpose, Explore";
        return textResult(`Unknown subagent "${agent}". Available: ${names}`);
      }
      if (!task) return textResult("Subagent task is empty");
      // ponytail: one child depth and no MCP inside the child. Add both when a subagent must call them.
      return textResult(await input.runSubagent(profile, task, signal));
    },
  });

  const proxy = tool<{
    server?: string;
    search?: string;
    describe?: string;
    tool?: string;
    args?: Record<string, unknown>;
  }>({
    name: "mcp",
    label: "MCP",
    description:
      "Call ZCode MCP servers without loading every tool schema. Omit fields to list servers. Set server plus search or describe to inspect one server. Set server, tool, and args to call.",
    promptSnippet: "Search or call a ZCode MCP server",
    promptGuidelines: [
      "Use mcp to discover and call MCP tools. Do not assume a server's tools are registered unless they were marked direct.",
    ],
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
        search: { type: "string", description: "Filter this server's tools by name or description" },
        describe: { type: "string", description: "Tool name whose schema should be returned" },
        tool: { type: "string", description: "Tool name to call" },
        args: {
          type: "object",
          description: "Arguments for tool",
          additionalProperties: true,
        },
      },
    },
    execute: async (_toolCallId, params, signal) => {
      await gateTool(input.check, "mcp", params);
      const result = await input.ports.useMcp({
        cwd: input.cwd,
        ...(typeof params.server === "string" ? { server: params.server } : {}),
        ...(typeof params.search === "string" ? { search: params.search } : {}),
        ...(typeof params.describe === "string" ? { describe: params.describe } : {}),
        ...(typeof params.tool === "string" ? { tool: params.tool } : {}),
        ...(params.args && typeof params.args === "object" ? { args: params.args } : {}),
        sessionId: input.sessionId,
        signal,
      });
      const text = result.text.trim() || (result.isError ? "MCP request failed" : "(empty)");
      return textResult(result.isError ? `MCP error: ${text}` : text);
    },
  });

  const mcpTools = await input.ports.listMcpTools(input.cwd).catch(() => []);
  const mcp = mcpTools
    .filter(
      (tool) =>
        tool.name && !reserved.has(tool.name) && tool.name !== subagent.name && tool.name !== proxy.name,
    )
    .map((mcpTool) =>
      tool<Record<string, unknown>>({

        name: mcpTool.name,
        label: mcpTool.name,
        description: mcpTool.description?.trim() || `MCP ${mcpTool.serverName}/${mcpTool.toolName}`,
        parameters: objectSchema(mcpTool.inputSchema),
        execute: async (_toolCallId, params, signal) => {
          await gateTool(input.check, mcpTool.name, params);
          const result = await input.ports.callMcpTool({
            serverName: mcpTool.serverName,
            toolName: mcpTool.toolName,
            arguments: params,
            sessionId: input.sessionId,
            signal,
          });
          const text = result.text.trim() || (result.isError ? "MCP tool failed" : "(empty)");
          return textResult(result.isError ? `MCP error: ${text}` : text);
        },
      }),
    );
  return [subagent, proxy, ...mcp];
}
