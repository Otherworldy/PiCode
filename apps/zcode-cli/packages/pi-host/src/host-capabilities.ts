import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { trackLiveSubagent } from "./live-subagents.js";
import { mapThought } from "./model-delegate.js";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import { createPermissionExtension, gateTool, type ToolPermissionCheck } from "./permission-gate.js";

export interface ZcodeSubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface PiCapabilityPorts {
  listSubagents(cwd: string): Promise<ZcodeSubagentProfile[]>;
}

const PI_BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

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
  check?: ToolPermissionCheck;
  /** SSH 工作区才传入。本地子会话用 Pi 内置工具，好让扩展替换 grep/find。 */
  sshTools?: readonly CodingTool[];
}): Promise<string> {
  await ensurePiSdk();
  if (input.signal?.aborted) return "subagent cancelled";
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = piCoding();
  const allowed = piToolNamesForAgent(
    input.profile.tools,
    input.sshTools?.map((tool) => tool.name) ?? PI_BUILTIN_TOOL_NAMES,
  );
  const childDir = join(
    dirname(input.parentSessionFile),
    basename(input.parentSessionFile, ".jsonl"),
    "picode-subagent",
  );
  await mkdir(childDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    noExtensions: true,
    noSkills: true,
    extensionFactories: [createPermissionExtension(input.check)],
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
    tools: allowed,
    ...(input.sshTools
      ? { customTools: input.sshTools.filter((tool) => allowed.includes(tool.name)) as never }
      : {}),
    resourceLoader: loader,
    sessionManager: SessionManager.create(input.cwd, childDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  let cancelled = false;
  const stopChild = () => {
    cancelled = true;
    void session.abort();
  };
  const readModel = () => ({
    provider: session.model?.provider ?? "",
    model: session.model?.id ?? "",
    thought: session.thinkingLevel ?? "",
  });
  // 父会话的工具 signal 和面板上的停止按钮都只停这一个子会话。
  // 模型切换同样只打到这个 session，不写子智能体设置。
  const release = trackLiveSubagent(session.sessionId, {
    abort: stopChild,
    getModel: readModel,
    setModel: async (next) => {
      const model = input.modelRuntime?.getModel(next.provider, next.model);
      if (!model) return false;
      await session.setModel(model);
      if (next.thought) session.setThinkingLevel(mapThought(next.thought));
      return true;
    },
  });
  input.signal?.addEventListener("abort", stopChild);
  try {
    await session.prompt(input.task);
    if (cancelled || input.signal?.aborted) return "subagent cancelled";
    return assistantText(session.messages as { role?: string; content?: unknown }[]) || "(no response)";
  } catch (error) {
    if (cancelled || input.signal?.aborted) return "subagent cancelled";
    return `subagent failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    release();
    input.signal?.removeEventListener("abort", stopChild);
    session.dispose();
  }
}

export async function createCapabilityTools(input: {
  cwd: string;
  ports: PiCapabilityPorts;
  check?: ToolPermissionCheck;
  sessionId?: string;
  runSubagent: (profile: ZcodeSubagentProfile, task: string, signal?: AbortSignal) => Promise<string>;
}) {
  const agents = await input.ports.listSubagents(input.cwd).catch(() => []);
  const catalog =
    agents.length > 0
      ? agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")
      : "- general-purpose\n- Explore";
  const subagent = tool<{ agent?: string; task?: string }>({
    name: "picode_subagent",
    label: "Subagent",
    description: `Run a PiCode subagent and return its final answer.\n${catalog}`,
    promptSnippet: "Delegate a task to a PiCode subagent",
    promptGuidelines: [
      "Use picode_subagent for work that should run in a separate agent. Pick a name from the tool description.",
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
      await gateTool(input.check, "picode_subagent", params);
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

  return [subagent];
}
