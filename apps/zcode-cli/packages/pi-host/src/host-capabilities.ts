import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { noteLiveSubagentUsage, trackLiveSubagent } from "./live-subagents.js";
import { mapThought } from "./model-delegate.js";
import { listPiAgentExtensions } from "./pi-agent-tools.js";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import { PI_BUILTIN_NAME_SET, piLocalToolNames } from "./pi-tool-names.js";
import {
  createPermissionExtension,
  gateTool,
  type ToolPermissionCheck,
} from "./permission-gate.js";

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
  /** `tools` 为 `["*"]` 时要减掉的工具名。 */
  toolsExclude?: readonly string[];
  /** 内置角色对缺失工具报错；用户/项目/插件角色维持原有的静默裁剪。 */
  source?: "built-in" | "user" | "project";
  /** 工具来自设置页覆盖时缺工具直接失败；角色默认缺失只静默裁剪。 */
  toolsSource?: "role" | "override";
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
  toolsExclude?: readonly string[];
  source?: "built-in" | "user" | "project";
  toolsSource?: "role" | "override";
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
    ...(profile.toolsExclude ? { toolsExclude: profile.toolsExclude } : {}),
    ...(profile.source ? { source: profile.source } : {}),
    ...(profile.toolsSource ? { toolsSource: profile.toolsSource } : {}),
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
  const thought = spec
    .slice(index + 1)
    .trim()
    .toLowerCase();
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
      thinkingLevel: thinkingOf(
        fallback.thought || input.profileThought,
        input.parentThinkingLevel,
      ),
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

/** 联网工具由用户扩展注册（pi-web-tools 等）。设置页存的是 Claude 风格的名字，这里对到实际工具名。 */
const PI_WEB_TOOL_ALIASES: Record<string, readonly string[]> = {
  web_search: ["one_search"],
  websearch: ["one_search"],
  fetch_content: ["web_fetch"],
  webfetch: ["web_fetch"],
};

/** Claude 风格名字的兼容映射；Pi 原名在 `piToolNamesForAgent` 里按精确名处理。 */
const PI_TOOL_ALIASES: Record<string, readonly string[]> = {
  read: ["read"],
  grep: ["grep"],
  glob: ["find", "ls"],
  find: ["find"],
  ls: ["ls"],
  bash: ["bash", "powershell"],
  powershell: ["powershell"],
  edit: ["edit"],
  write: ["write"],
};

export function piToolNamesForAgent(
  tools: readonly string[] | undefined,
  available: readonly string[],
  excludeTools?: readonly string[],
): string[] {
  const excluded = new Set(excludeTools ?? []);
  const withoutExcluded = (names: string[]) => names.filter((name) => !excluded.has(name));
  // 缺省与通配都是“全部可用工具”；空数组是显式“无工具”（对齐 pi-subagents）。
  if (!tools) return withoutExcluded([...available]);
  if (tools.some((name) => name.trim() === "*" || name.trim() === "inherit")) {
    return withoutExcluded([...available]);
  }
  const allowed = new Set<string>();
  for (const raw of tools) {
    const rawName = raw.trim();
    if (!rawName) continue;
    // Pi 原名按精确名收口：设置页取消勾选的工具不能因为别名展开又回来。
    if (PI_BUILTIN_NAME_SET.has(rawName)) {
      if (available.includes(rawName)) allowed.add(rawName);
      continue;
    }
    const name = rawName.toLowerCase();
    const web = PI_WEB_TOOL_ALIASES[name];
    if (web) {
      // 联网工具由扩展注册，名字对上了就进白名单；未安装时只是多一个无效项。
      for (const mapped of web) allowed.add(mapped);
      continue;
    }
    const builtin = PI_TOOL_ALIASES[name];
    if (builtin) {
      // 内置工具只认 available 里真有的实现，SSH 工作区才不会落回本机工具。
      for (const mapped of builtin) if (available.includes(mapped)) allowed.add(mapped);
      continue;
    }
    // 其余名字当扩展工具原样放行，pi-web-tools 的 one_search / web_fetch 就是这一类。
    // 保留原大小写：Pi 按精确名匹配。
    allowed.add(rawName);
  }
  return withoutExcluded([
    ...available.filter((name) => allowed.has(name)),
    ...[...allowed].filter((name) => !available.includes(name)),
  ]);
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

/** 角色声明的工具解析成 Pi 实际工具名：Pi 原名精确，别名展开，通配无目标。 */
function piRequestedToolTargets(tools: readonly string[] | undefined): string[] {
  const targets = new Set<string>();
  for (const raw of tools ?? []) {
    const name = raw.trim();
    if (!name || name === "*" || name === "inherit") continue;
    if (PI_BUILTIN_NAME_SET.has(name)) {
      targets.add(name);
      continue;
    }
    const lower = name.toLowerCase();
    const mapped = PI_WEB_TOOL_ALIASES[lower] ?? PI_TOOL_ALIASES[lower];
    if (mapped) {
      for (const target of mapped) targets.add(target);
      continue;
    }
    targets.add(name);
  }
  return [...targets];
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
  const requestedTargets = piRequestedToolTargets(input.profile.tools);
  const extensionToolNames = requestedTargets.filter((name) => !PI_BUILTIN_NAME_SET.has(name));
  const extensionPaths: string[] = [];
  const extensionTools: string[] = [];
  if (extensionToolNames.length > 0) {
    // 白名单只管声明；提供工具的扩展要按名字反查并显式加载，不能把用户全部插件再起一份。
    const wanted = new Set(extensionToolNames);
    for (const extension of await listPiAgentExtensions(input.cwd, input.agentDir)) {
      if (!extension.tools.some((tool) => wanted.has(tool))) continue;
      extensionPaths.push(extension.path);
      extensionTools.push(...extension.tools);
    }
  }
  const available = [
    ...(input.sshTools?.map((tool) => tool.name) ?? piLocalToolNames()),
    ...extensionTools,
  ];
  const allowed = piToolNamesForAgent(input.profile.tools, available, input.profile.toolsExclude);
  // 设置页显式配过的扩展工具是产品承诺：缺 provider 就失败，而不是静默少一个。
  // 内置工具的平台差异（如非 Windows 的 powershell）和角色默认缺失只静默裁剪。
  if (input.profile.toolsSource === "override") {
    const missing = requestedTargets.filter(
      (name) => !PI_BUILTIN_NAME_SET.has(name) && !available.includes(name),
    );
    if (missing.length > 0) return `subagent failed: tools not available: ${missing.join(", ")}`;
  }
  const childDir = join(
    dirname(input.parentSessionFile),
    basename(input.parentSessionFile, ".jsonl"),
    "picode-subagent",
  );
  await mkdir(childDir, { recursive: true });
  // 子会话要拿到用户 Pi 包里的联网工具，就得让 Pi 看到 packages。
  // packages 按 global / project 两个 scope 读，合并成一份会弄丢其中一边；
  // 用内存 storage 保存两个 scope 的快照，子会话写设置也不会落到用户文件。
  const fileSettings = SettingsManager.create(input.cwd, input.agentDir);
  const stored = {
    global: JSON.stringify(fileSettings.getGlobalSettings()),
    project: JSON.stringify(fileSettings.getProjectSettings()),
  };
  const childSettings = SettingsManager.fromStorage({
    withLock(scope, fn) {
      const next = fn(stored[scope]);
      if (next !== undefined) stored[scope] = next;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: childSettings,
    // 只加载白名单需要的扩展，不加载用户的全部包；技能不加载。
    // codemode / tool-search / MCP 是 Pi 内置扩展，只有注册了它们的工厂才会加载，这里没注册。
    noExtensions: true,
    ...(extensionPaths.length > 0 ? { additionalExtensionPaths: extensionPaths } : {}),
    noSkills: true,
    extensionFactories: [createPermissionExtension(input.check)],
    appendSystemPrompt: [input.profile.systemPrompt || input.profile.description].filter(
      (line) => line.trim().length > 0,
    ),
  });
  await loader.reload();
  // reload() 会重读设置，把之前 applyOverrides 的 retry 开关抹掉，所以关重试放在它之后。
  childSettings.applyOverrides({ retry: { enabled: false } });
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
    settingsManager: childSettings,
  });
  // 扩展的 session_start 与 resources_discover 只在 bindExtensions 里发；子会话要跑
  // 扩展的请求期 hook 就得显式绑一次。扩展报错不挡子会话，由扩展自己承担。
  await session.bindExtensions({ mode: "print" }).catch(() => undefined);
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
    return (
      assistantText(session.messages as { role?: string; content?: unknown }[]) || "(no response)"
    );
  } catch (error) {
    if (cancelled || input.signal?.aborted) return "subagent cancelled";
    return `subagent failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await writeRole();
    stopUsage();
    release();
    input.signal?.removeEventListener("abort", stopChild);
    // dispose() 不替扩展收尾；和 Pi 自己的宿主一样，先发一次 session_shutdown。
    // 第三方 handler 不 resolve 时不能卡死父会话，所以给一个有界等待。
    try {
      const runner = session.extensionRunner;
      if (runner.hasHandlers("session_shutdown")) {
        await Promise.race([
          runner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 5000).unref?.();
          }),
        ]);
      }
    } catch {
      // 收尾失败不改变子会话结果。
    }
    session.dispose();
  }
}

export async function createCapabilityTools(input: {
  cwd: string;
  ports: PiCapabilityPorts;
  check?: ToolPermissionCheck;
  sessionId?: string;
  runSubagent: (
    profile: ZcodeSubagentProfile,
    task: string,
    signal?: AbortSignal,
  ) => Promise<string>;
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
