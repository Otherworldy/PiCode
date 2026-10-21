import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { noteLiveSubagentUsage, trackLiveSubagent } from "./live-subagents.js";
import { mapThought } from "./model-delegate.js";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import { createPermissionExtension, gateTool, type ToolPermissionCheck } from "./permission-gate.js";

export interface ZcodeSubagentModel {
  providerId: string;
  modelId: string;
  thought?: string;
}

export interface ZcodeSubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: readonly string[];
  /** 设置里的角色覆盖。缺席才继续看 defaultModel 和父会话。 */
  model?: ZcodeSubagentModel;
  /** 角色自己的思考档位。覆盖没带档位时仍用它。 */
  thought?: string;
}

const THOUGHT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function toZcodeSubagentProfile(profile: {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: readonly string[];
  thinking?: string;
  modelSelection?: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  };
}): ZcodeSubagentProfile {
  const selection = profile.modelSelection;
  const thought = selection?.options?.reasoningLevel?.trim();
  const roleThought = profile.thinking?.trim();
  return {
    name: profile.name,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    ...(profile.tools ? { tools: profile.tools } : {}),
    ...(roleThought ? { thought: roleThought } : {}),
    ...(selection?.providerId && selection.modelId
      ? {
          model: {
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(thought ? { thought } : {}),
          },
        }
      : {}),
  };
}

export function subagentDefaultModelFromSettings(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const subagents = (value as { subagents?: { defaultModel?: unknown } }).subagents;
  const model = subagents?.defaultModel;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

async function readSubagentDefaultModel(agentDir: string): Promise<string | undefined> {
  try {
    return subagentDefaultModelFromSettings(
      JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown,
    );
  } catch {
    return undefined;
  }
}

function splitModelThought(spec: string): { body: string; thought?: string } {
  const index = spec.lastIndexOf(":");
  if (index <= 0) return { body: spec };
  const thought = spec.slice(index + 1).trim().toLowerCase();
  if (!THOUGHT_LEVELS.has(thought)) return { body: spec };
  return { body: spec.slice(0, index).trim(), thought };
}

function thinkingOf(
  explicit: string | undefined,
  fallback: CreateAgentSessionOptions["thinkingLevel"] | undefined,
): CreateAgentSessionOptions["thinkingLevel"] | undefined {
  return explicit?.trim() ? mapThought(explicit) : fallback;
}

/** 角色覆盖 > subagents.defaultModel > 父会话。写了但目录没有就失败。 */
export function resolveZcodeSubagentLaunchModel<TModel>(input: {
  profileModel?: ZcodeSubagentModel;
  profileThought?: string;
  defaultModel?: string;
  parentModel?: TModel;
  parentProviderId?: string;
  parentThinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  getModel: (providerId: string, modelId: string) => TModel | null | undefined;
  listModels?: () => readonly { providerId: string; modelId: string }[];
}): {
  model?: TModel;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  error?: string;
} {
  const pinned = input.profileModel;
  if (pinned) {
    const model = input.getModel(pinned.providerId, pinned.modelId);
    if (!model) return { error: `model ${pinned.providerId}/${pinned.modelId} is not available` };
    return {
      model,
      thinkingLevel: thinkingOf(pinned.thought || input.profileThought, input.parentThinkingLevel),
    };
  }
  const fallback = resolveDefaultModel(input);
  if (fallback.error) return { error: fallback.error };
  if (fallback.model) {
    return {
      model: fallback.model,
      thinkingLevel: thinkingOf(fallback.thought || input.profileThought, input.parentThinkingLevel),
    };
  }
  return {
    model: input.parentModel,
    thinkingLevel: thinkingOf(input.profileThought, input.parentThinkingLevel),
  };
}

function resolveDefaultModel<TModel>(input: {
  defaultModel?: string;
  parentProviderId?: string;
  getModel: (providerId: string, modelId: string) => TModel | null | undefined;
  listModels?: () => readonly { providerId: string; modelId: string }[];
}): { model?: TModel; thought?: string; error?: string } {
  const spec = input.defaultModel?.trim();
  if (!spec) return {};
  const { body, thought } = splitModelThought(spec);
  const slash = body.indexOf("/");
  if (slash > 0) {
    const model = input.getModel(body.slice(0, slash), body.slice(slash + 1));
    return model ? { model, thought } : { error: `model ${spec} is not available` };
  }
  const matches = (input.listModels?.() ?? []).filter((model) => model.modelId === body);
  const chosen =
    matches.find((model) => model.providerId === input.parentProviderId) ??
    (matches.length === 1 ? matches[0] : undefined);
  const model = chosen ? input.getModel(chosen.providerId, chosen.modelId) : undefined;
  return model ? { model, thought } : { error: `model ${spec} is not available` };
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
  const launchModel = resolveZcodeSubagentLaunchModel({
    profileModel: input.profile.model,
    profileThought: input.profile.thought,
    defaultModel: await readSubagentDefaultModel(input.agentDir),
    parentModel: input.model,
    parentProviderId: input.model?.provider,
    parentThinkingLevel: input.thinkingLevel,
    getModel: (providerId, modelId) => input.modelRuntime?.getModel(providerId, modelId),
    listModels: () =>
      input.modelRuntime?.getAvailableSnapshot().map((model) => ({
        providerId: model.provider,
        modelId: model.id,
      })) ?? [],
  });
  if (launchModel.error) return `subagent failed: ${launchModel.error}`;
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
    ...(launchModel.model ? { model: launchModel.model } : {}),
    ...(launchModel.thinkingLevel ? { thinkingLevel: launchModel.thinkingLevel } : {}),
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
  const agentName = input.profile.name.trim();
  // 角色名不在 Pi 的会话头里。写在 jsonl 旁边，目录不用从提示词猜。
  const writeRole = async () => {
    const sessionFile = session.sessionFile;
    if (!sessionFile || !agentName) return;
    await writeFile(`${sessionFile}.role`, `${agentName}\n`, "utf8").catch(() => undefined);
  };
  await writeRole();
  const release = trackLiveSubagent(session.sessionId, {
    abort: stopChild,
    agentName,
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
  // 子会话的用量只有这里看得到：父会话要等它结束才拿到最终文本，
  // 所以订阅 message_end 把每次模型调用累加进活表，面板才能边跑边显示。
  // 首 token 等待的口径与 `PiToV4Projector.recordTurnUsage` 对齐：起点用 Pi 的
  // 请求时间戳，打点只认真正的输出增量（toolcall 也算），否则同一个子会话
  // 在面板与侧栏会算出两个吐字速度。
  let childRequestStartedAt: number | undefined;
  let childFirstTokenAt: number | undefined;
  const stopUsage = session.subscribe((event) => {
    if (event.type === "message_start") {
      if (event.message.role !== "assistant") return;
      childRequestStartedAt = event.message.timestamp ?? Date.now();
      childFirstTokenAt = undefined;
      return;
    }
    if (event.type === "message_update") {
      if (childFirstTokenAt !== undefined) return;
      const kind = event.assistantMessageEvent.type;
      if (
        kind === "text_delta" ||
        kind === "thinking_delta" ||
        kind === "toolcall_start" ||
        kind === "toolcall_delta"
      ) {
        childFirstTokenAt = Date.now();
      }
      return;
    }
    if (event.type !== "message_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    // 与 projector 同样对缺失字段兜底：NaN 会让 usage 校验失败，整帧 state.updated 被拒收。
    const inputTokens = Math.max(0, message.usage.input ?? 0);
    const cacheReadTokens = Math.max(0, message.usage.cacheRead ?? 0);
    const cacheWriteTokens = Math.max(0, message.usage.cacheWrite ?? 0);
    const outputTokens = Math.max(0, message.usage.output ?? 0);
    // 失败、中断和 deferred 回填也会走 message_end，Pi 这时给的 usage 是全零。
    if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens === 0) return;
    noteLiveSubagentUsage(session.sessionId, {
      providerId: message.provider,
      modelId: message.model,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      ...(message.durationMs === undefined
        ? {}
        : { llmDurationMs: Math.max(0, message.durationMs) }),
      ...(childRequestStartedAt === undefined || childFirstTokenAt === undefined
        ? {}
        : { ttftMs: Math.max(0, childFirstTokenAt - childRequestStartedAt) }),
    });
    childRequestStartedAt = undefined;
    childFirstTokenAt = undefined;
  });
  try {
    await session.prompt(input.task);
    if (cancelled || input.signal?.aborted) return "subagent cancelled";
    return assistantText(session.messages as { role?: string; content?: unknown }[]) || "(no response)";
  } catch (error) {
    if (cancelled || input.signal?.aborted) return "subagent cancelled";
    return `subagent failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await writeRole();
    stopUsage();
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
      : "- scout\n- researcher\n- evidence-auditor\n- worker\n- reviewer\n- oracle\n- delegate";
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
        const names =
          profiles.map((item) => item.name).join(", ") ||
          "scout, researcher, evidence-auditor, worker, reviewer, oracle, delegate";
        return textResult(`Unknown subagent "${agent}". Available: ${names}`);
      }
      if (!task) return textResult("Subagent task is empty");
      // ponytail: one child depth and no MCP inside the child. Add both when a subagent must call them.
      return textResult(await input.runSubagent(profile, task, signal));
    },
  });

  return [subagent];
}
