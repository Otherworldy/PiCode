import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import { createPiProcessBridge } from "./pi-process-bridge.js";
import { retainZcodePluginPlan, zcodePluginLoaderExtras } from "./pi-plugins.js";
import {
  expandUnloadedPromptTemplate,
  listSessionSlashCommands,
  registeredExtensionCommandText,
} from "./pi-slash-commands.js";
import { toPiSkillView } from "./pi-skills.js";
import { branchPiSessionFile, openOrCreateSession } from "./session-files.js";
import { shutdownPiSession } from "./session-shutdown.js";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { lowestPiThought, piAssistantText } from "./pi-assistant-text.js";
import {
  createCapabilityTools,
  runZcodeSubagent,
  type PiCapabilityPorts,
  type ZcodeSubagentProfile,
} from "./host-capabilities.js";
import { createBackgroundSubagents } from "./subagent-background.js";
import { readPiContextUsage } from "./context-breakdown.js";
import { createPermissionExtension } from "./permission-gate.js";
import { createUiDesignMode } from "./ui-design-mode.js";
import { createPlanReviewSignalExtension, takePlanDecision } from "./plan-review-signal.js";
import { captureAbandonedBranch, summarizeAbandonedBranch } from "./branch-summary.js";
import {
  contextEventsOf,
  trimAssistantContentAtToolCall,
  deleteSessionBranch,
  labelSessionEntry,
  readSessionTree,
  resolveSessionEntry,
} from "./session-tree.js";
import {
  createDelegateProvider,
  mapThought,
  type DelegateProvider,
  type ZCodeModelStreamPort,
} from "./model-delegate.js";
import {
  readProcessSshRemoteSpec,
  readSshProjectSystemPrompt,
  sshCodingToolOptions,
  sshWorkspacePrompt,
} from "./ssh-remote.js";
import {
  omitFailedAssistantForContinue,
  runContinueAfterModelError,
} from "./continue-after-error.js";
import {
  createLazyChromeDevtoolsExtension,
  lazyChromeDevtoolsPrompt,
} from "./chrome-devtools-lazy.js";
import {
  createZcodeMcpTransport,
  loadLazyChromeDevtoolsServers,
  loadZcodeMcpConfig,
  registerableMcpServers,
  type PiMcpCompat,
} from "./pi-mcp.js";
import { asPiEvent, type CreatePiSession, type PiSessionPort } from "./types.js";
import {
  alignStoredModelApi,
  deleteProvider,
  discoverPiModels,
  loadModelsJson,
  saveModelsJson,
  storedApiKey,
  toPiModelConfigView,
  toRuntimeConfig,
  upsertProvider,
  type PiDiscoveredModel,
  type PiModelConfigView,
  type PiProviderDraft,
} from "./model-config-file.js";
import {
  applyTitleSummaryPatch,
  readTitleSummarySettings,
  writeTitleSummarySettings,
} from "./session-title-summary.js";

async function createIsolatedRuntime(delegate: DelegateProvider): Promise<ModelRuntime> {
  const runtime = await piCoding().ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(delegate.provider);
  return runtime;
}

let productionRuntime: Promise<ModelRuntime> | undefined;

function getProductionModelRuntime(): Promise<ModelRuntime> {
  productionRuntime ??= ensurePiSdk().then(async () => {
    const coding = piCoding();
    await alignStoredModelApi(coding.getAgentDir());
    return coding.ModelRuntime.create();
  });
  return productionRuntime;
}

/**
 * One-shot Pi completion for auxiliary calls (git commit message).
 * Returns null when the catalog has no such model so the caller can fall back.
 */
export async function completePiPrompt(input: {
  providerId: string;
  modelId: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  const prompt = input.prompt.trim();
  const system = input.system?.trim();
  if (!providerId || !modelId || !prompt) return null;
  const runtime = await getProductionModelRuntime();
  const model = runtime.getModel(providerId, modelId);
  if (!model) return null;
  const thought = lowestPiThought(model);
  let message: AssistantMessage | undefined;
  for await (const event of runtime.streamSimple(
    model,
    {
      ...(system ? { systemPrompt: system } : {}),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      ...(thought === "off" ? {} : { reasoning: thought }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )) {
    if (event.type === "done") message = event.message;
    else if (event.type === "error") {
      throw new Error(event.error.errorMessage?.trim() || "模型请求失败。");
    }
  }
  if (!message) throw new Error("模型响应缺少文本内容。");
  return piAssistantText(message);
}

// thinkingLevelMap 值为 null 表示没有该思考等级，目录列表同步时过滤掉。
function thoughtLevelsOf(model: { thinkingLevelMap?: Record<string, unknown> }): string[] {
  const map = model.thinkingLevelMap;
  if (map && typeof map === "object") {
    return Object.entries(map)
      .filter(([, value]) => value !== null)
      .map(([key]) => key);
  }
  return ["off", "low", "medium", "high"];
}

function catalogContextWindow(model: { contextWindow?: number }): number | undefined {
  const value = model.contextWindow;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export async function listPiCatalog(): Promise<{
  models: Array<{
    providerId: string;
    modelId: string;
    name?: string;
    thoughtLevels: string[];
    contextWindow?: number;
  }>;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThought?: string;
}> {
  const runtime = await getProductionModelRuntime();
  const settings = piCoding().SettingsManager.create(process.cwd(), piCoding().getAgentDir());
  return {
    models: runtime.getAvailableSnapshot().map((model) => {
      const contextWindow = catalogContextWindow(model);
      return {
        providerId: model.provider,
        modelId: model.id,
        name: model.name,
        thoughtLevels: thoughtLevelsOf(model),
        ...(contextWindow ? { contextWindow } : {}),
      };
    }),
    defaultProvider: settings.getDefaultProvider(),
    defaultModel: settings.getDefaultModel(),
    defaultThought: settings.getDefaultThinkingLevel() ?? "medium",
  };
}

export type PiModelsAction = "get" | "upsert" | "delete" | "setDefault" | "discover";

export async function mutatePiCatalog(input: {
  action: PiModelsAction;
  provider?: PiProviderDraft;
  providerId?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThought?: string;
  titleSummaryEnabled?: boolean;
  titleSummaryProvider?: string;
  titleSummaryModel?: string;
}): Promise<
  PiModelConfigView & {
    discovered?: PiDiscoveredModel[];
    titleSummaryEnabled: boolean;
    titleSummaryProvider?: string;
    titleSummaryModel?: string;
  }
> {
  await ensurePiSdk();
  const agentDir = piCoding().getAgentDir();
  const settings = piCoding().SettingsManager.create(process.cwd(), agentDir);
  let file = await loadModelsJson(agentDir);
  const finish = async <T extends PiModelConfigView>(view: T) => {
    const summary = await readTitleSummarySettings(agentDir);
    return {
      ...view,
      titleSummaryEnabled: summary.enabled,
      ...(summary.provider ? { titleSummaryProvider: summary.provider } : {}),
      ...(summary.model ? { titleSummaryModel: summary.model } : {}),
    };
  };

  if (input.action === "upsert" && input.provider) {
    file = upsertProvider(file, input.provider);
    await saveModelsJson(agentDir, file);
    const runtime = await getProductionModelRuntime();
    const stored = file.providers?.[input.provider.id];
    if (stored) runtime.registerProvider(input.provider.id, toRuntimeConfig(stored) as never);
  } else if (input.action === "delete" && input.providerId) {
    file = deleteProvider(file, input.providerId);
    await saveModelsJson(agentDir, file);
    const runtime = await getProductionModelRuntime();
    runtime.unregisterProvider(input.providerId);
  } else if (input.action === "setDefault") {
    let defaultsChanged = false;
    if (input.defaultProvider && input.defaultModel) {
      settings.setDefaultModelAndProvider(input.defaultProvider, input.defaultModel);
      defaultsChanged = true;
    }
    if (input.defaultThought) {
      settings.setDefaultThinkingLevel(mapThought(input.defaultThought));
      defaultsChanged = true;
    }
    if (defaultsChanged) await settings.flush();
    if (
      input.titleSummaryEnabled !== undefined ||
      input.titleSummaryProvider !== undefined ||
      input.titleSummaryModel !== undefined
    ) {
      const current = await readTitleSummarySettings(agentDir);
      await writeTitleSummarySettings(
        agentDir,
        applyTitleSummaryPatch(current, {
          ...(input.titleSummaryEnabled !== undefined
            ? { enabled: input.titleSummaryEnabled }
            : {}),
          ...(input.titleSummaryProvider !== undefined
            ? { provider: input.titleSummaryProvider }
            : {}),
          ...(input.titleSummaryModel !== undefined ? { model: input.titleSummaryModel } : {}),
        }),
      );
    }
  } else if (input.action === "discover") {
    const baseUrl = input.provider?.baseUrl ?? "";
    const apiKey =
      input.provider?.apiKey || storedApiKey(file, input.providerId ?? input.provider?.id ?? "");
    const discovered = await discoverPiModels(baseUrl, apiKey);
    return finish({
      ...toPiModelConfigView(file, {
        defaultProvider: settings.getDefaultProvider(),
        defaultModel: settings.getDefaultModel(),
        defaultThought: settings.getDefaultThinkingLevel() ?? "medium",
      }),
      discovered,
    });
  }

  return finish(
    toPiModelConfigView(file, {
      defaultProvider: settings.getDefaultProvider(),
      defaultModel: settings.getDefaultModel(),
      defaultThought: settings.getDefaultThinkingLevel() ?? "medium",
    }),
  );
}

export { branchPiSessionFile };

const BUILTIN_SEARCH_TOOLS = ["grep", "find", "ls"] as const;

function isAgentAlreadyProcessing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already processing");
}

/** Pi 默认不激活这些工具。扩展卸掉后，只要定义还在就补上。 */
export function withBuiltinSearchTools(
  active: readonly string[],
  available: readonly string[],
): string[] {
  const present = new Set(available);
  const next = [...active];
  const seen = new Set(active);
  for (const name of BUILTIN_SEARCH_TOOLS) {
    if (seen.has(name) || !present.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

/** 子会话才省略。对话分叉有父会话 id，仍要挂 codemode / tool_search / MCP。 */
export function mountPiHostExtensions(input: {
  isolated: boolean;
  loadExtensions: boolean;
  omitHostExtensions?: boolean;
}): boolean {
  return !input.isolated && input.loadExtensions && input.omitHostExtensions !== true;
}

export function createSdkSessionFactory(
  options: {
    delegate?: DelegateProvider;
    stream?: ZCodeModelStreamPort["stream"];
    defaultSelection?: { providerId: string; modelId: string; thought?: string };
    agentDir?: string;
    capabilities?: PiCapabilityPorts;
    /** Plugin and node_repl servers, plus official-auth hooks. User servers stay in Pi mcp.json. */
    mcpCompat?: PiMcpCompat;
    skillPaths?: (cwd: string) => string[];
    /** 测试注入。生产路径仍用 Pi 的 ModelRuntime。 */
    modelRuntime?: ModelRuntime;
  } = {},
): CreatePiSession {
  const isolated = Boolean(options.delegate || options.stream);
  const selections = new Map<string, { providerId: string; modelId: string; thought?: string }>();
  const inner =
    options.stream ??
    async function* () {
      yield { type: "done" as const };
    };
  const stream: ZCodeModelStreamPort["stream"] = async function* (input) {
    const selected =
      (input.sessionId ? selections.get(input.sessionId) : undefined) ?? options.defaultSelection;
    yield* inner({
      ...input,
      ...(selected
        ? {
            providerId: selected.providerId,
            modelId: selected.modelId,
            thought: selected.thought,
          }
        : {}),
    });
  };
  const delegate = isolated ? (options.delegate ?? createDelegateProvider({ stream })) : undefined;
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const runtime = () => {
    const injected = options.modelRuntime;
    if (injected) return ensurePiSdk().then(() => injected);
    runtimePromise ??= ensurePiSdk().then(() =>
      isolated && delegate ? createIsolatedRuntime(delegate) : getProductionModelRuntime(),
    );
    return runtimePromise;
  };

  return async (input) => {
    const modelRuntime = await runtime();
    const agentDir =
      options.agentDir ??
      (input.loadExtensions ? piCoding().getAgentDir() : join(tmpdir(), "zcode-pi-no-ext"));
    const settingsManager = isolated
      ? piCoding().SettingsManager.inMemory({ retry: { enabled: false } })
      : piCoding().SettingsManager.create(input.cwd, agentDir);
    const ssh = readProcessSshRemoteSpec(input.cwd);
    const pluginExtras =
      !isolated && input.loadExtensions
        ? await zcodePluginLoaderExtras(input.cwd, agentDir, options.skillPaths?.(input.cwd) ?? [])
        : undefined;
    const processes = !isolated && input.loadExtensions ? createPiProcessBridge() : undefined;
    // 分叉会带 parentSessionId，用来记父会话。以前用它关掉 codemode / tool_search / MCP，
    // 分支请求里就没有 codemode 和 mcp__node_repl__js。只有子会话显式省略这些扩展。
    const usePiMcp = mountPiHostExtensions({
      isolated,
      loadExtensions: input.loadExtensions,
      omitHostExtensions: input.omitHostExtensions,
    });
    const mcpRuntime = usePiMcp
      ? registerableMcpServers(
          (await options.mcpCompat?.runtimeServers({
            cwd: input.cwd,
            sessionId: input.sessionId,
          })) ?? [],
        )
      : [];
    const codingForMcp = usePiMcp ? piCoding() : undefined;
    const lazyChrome = usePiMcp ? loadLazyChromeDevtoolsServers(agentDir, input.cwd) : [];
    const extraSystemPrompts = [
      ...(ssh ? [sshWorkspacePrompt(ssh)] : []),
      ...(lazyChrome.length > 0 ? [lazyChromeDevtoolsPrompt(lazyChrome)] : []),
    ];
    // Pi 用本机 fs 按 cwd 找 .pi/SYSTEM.md。SSH 在 Windows 上会把远端路径 resolve 成本机盘符，
    // 项目提示词实际在远端。远端文件存在时用它替换发现结果，保持「项目优先于全局」。
    // 直接传 appendSystemPrompt 会关掉文件发现，所以额外说明走 override，接在追加段后面。
    const [sshProjectSystemPrompt, sshProjectAppendPrompt] = ssh
      ? await Promise.all([
          readSshProjectSystemPrompt(ssh),
          readSshProjectSystemPrompt(ssh, "append"),
        ])
      : [undefined, undefined];
    const planDecisions: string[] = [];
    let designReviewOpened = false;
    // 审查页由模型自己调 plannotator 打开。宿主只记下来，让时间线留在「工作中」。
    const uiDesign = createUiDesignMode(input.cwd, () => {
      designReviewOpened = true;
    });
    const resourceLoader = new (piCoding().DefaultResourceLoader)({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      ...(pluginExtras?.loader ?? { additionalSkillPaths: options.skillPaths?.(input.cwd) ?? [] }),
      extensionFactories: [
        createPermissionExtension(input.checkPermission),
        uiDesign.extension,
        createPlanReviewSignalExtension((text) => {
          planDecisions.push(text);
        }),
        ...(usePiMcp && codingForMcp
          ? [
              (pi: {
                registerMcpServer(
                  name: string,
                  config: (typeof mcpRuntime)[number]["config"],
                ): void;
              }) => {
                for (const server of mcpRuntime) pi.registerMcpServer(server.name, server.config);
              },
              codingForMcp.createCodemodeExtension(),
              codingForMcp.createToolSearchExtension(),
              ...(lazyChrome.length > 0 ? [createLazyChromeDevtoolsExtension(lazyChrome)] : []),
              codingForMcp.createMcpExtension({
                loadConfig: () => loadZcodeMcpConfig(agentDir, input.cwd),
                createTransport: createZcodeMcpTransport({
                  compat: options.mcpCompat,
                  sessionId: input.sessionId,
                }),
              }),
            ]
          : []),
        ...(processes?.factories ?? []),
      ],
      ...(sshProjectSystemPrompt !== undefined
        ? { systemPromptOverride: () => sshProjectSystemPrompt }
        : {}),
      ...(extraSystemPrompts.length > 0 || sshProjectAppendPrompt !== undefined
        ? {
            appendSystemPromptOverride: (base: string[]) => [
              ...(sshProjectAppendPrompt !== undefined ? [sshProjectAppendPrompt] : base),
              ...extraSystemPrompts,
            ],
          }
        : {}),
    });
    await resourceLoader.reload();
    // 关掉的包技能不能只摘一次：后面的 resources_discover 会整表重载。
    if (pluginExtras) retainZcodePluginPlan(resourceLoader, pluginExtras.plan);
    // 本地不塞 read/bash/grep/find。Pi 自己有，扩展（pi-fff）才能按原名换掉。
    // SSH 必须换成远端读写，否则这些工具打到本机盘。
    const sshTools = ssh ? piCoding().createCodingTools(input.cwd, sshCodingToolOptions(ssh)) : [];
    let live: CreateAgentSessionResult["session"] | undefined;
    // 子会话要写在真实父文件旁边，目录页才扫得到。
    const launchSubagent = (
      profile: ZcodeSubagentProfile,
      task: string,
      extra: { signal?: AbortSignal; onStarted?: (childSessionId: string) => void },
    ) =>
      runZcodeSubagent({
        cwd: input.cwd,
        // Pi 落盘文件名带自己的时间戳，和注册表预先拼的路径不是同一个。
        parentSessionFile: live?.sessionFile || input.sessionFile,
        profile,
        task,
        check: input.checkPermission,
        modelRuntime,
        model: live?.model,
        thinkingLevel: live?.thinkingLevel,
        agentDir,
        ...extra,
        ...(sshTools.length > 0 ? { sshTools } : {}),
      });
    // 后台派发的所有者是这个会话：并发上限、取消与结果投递都只在它这里。
    const backgroundSubagents = createBackgroundSubagents({
      run: (profile, task, onStarted) => launchSubagent(profile, task, { onStarted }),
      notify: (text) => {
        // 投递失败不改子代理的结算，但不能静默：这是结果的唯一副本。
        void live
          ?.sendCustomMessage(
            { customType: "picode_subagent_result", display: true, content: text },
            { triggerTurn: true, deliverAs: "followUp" },
          )
          .catch((error: unknown) => {
            console.error("background subagent result delivery failed", error);
          });
      },
    });
    const capabilityTools = options.capabilities
      ? await createCapabilityTools({
          cwd: input.cwd,
          ports: options.capabilities,
          check: input.checkPermission,
          sessionId: input.sessionId,
          runSubagent: (profile, task, runOptions) =>
            runOptions.background
              ? Promise.resolve(backgroundSubagents.start(profile, task))
              : launchSubagent(profile, task, { signal: runOptions.signal }),
        })
      : [];
    const created = await piCoding().createAgentSession({
      cwd: input.cwd,
      agentDir,
      ...(isolated && delegate ? { model: delegate.model, thinkingLevel: "off" as const } : {}),
      modelRuntime,
      customTools: [...sshTools, ...capabilityTools] as never,
      // 不传 tools 白名单，也不关 builtin。插件工具保持启用，同名工具由插件替换。
      // 插件自带的 subagent 与 PiCode 代理定义冲突，主会话禁用它。
      ...(options.capabilities ? { excludeTools: ["subagent"] } : {}),
      resourceLoader,
      sessionManager: openOrCreateSession(input),
      settingsManager,
    });
    live = created.session;
    const session = created.session;
    // 编辑历史消息会先 abort 再 prompt。abort 的 agent_settled 和插件仍可能在
    // isStreaming 落下之前再进一次 prompt。Pi 抛 already processing，调用方经常不 await，
    // 进程错误边界会把 agent 打退出：模型第一句刚写出会话就没了。这里改成 followUp。
    const rawPrompt = session.prompt.bind(session);
    session.prompt = (async (text: string, options?: Parameters<typeof session.prompt>[1]) => {
      try {
        return await rawPrompt(text, options);
      } catch (error) {
        if (options?.streamingBehavior || !isAgentAlreadyProcessing(error)) throw error;
        return rawPrompt(text, { ...options, streamingBehavior: "followUp" });
      }
    }) as typeof session.prompt;
    const persistedListeners = new Set<(notice: { role: string; entryId: string }) => void>();
    // Bug：分叉把 row.entityId 当成树节点。Pi 的节点 id 在 appendMessage 才生成，
    // 而且发生在 message_end 监听者返回之后。不在这里接住，实时会话永远 Entry not found。
    const manager = session.sessionManager;
    const appendMessage = manager.appendMessage.bind(manager);
    manager.appendMessage = ((message: { role?: string }) => {
      const entryId = appendMessage(message as never);
      if (message?.role === "assistant") {
        for (const listener of persistedListeners) listener({ role: "assistant", entryId });
      }
      return entryId;
    }) as typeof manager.appendMessage;
    if (!ssh) {
      // Pi 默认不激活 grep/find/ls。fff 这类扩展按原名注册时它们才出现；
      // 扩展卸掉后内置定义还在，这里把没被占用的补进激活列表。
      const active = session.getActiveToolNames();
      const next = withBuiltinSearchTools(
        active,
        ["grep", "find", "ls"].filter((name) => session.getToolDefinition(name)),
      );
      if (next.length !== active.length) session.setActiveToolsByName(next);
    }
    if (ssh) {
      // createAgentSession 会 path.resolve。Windows 上 /root/app 变成 C:\root\app，
      // 系统提示和会话头都跟着错。建完再改回远端路径，并重建提示。
      (session.sessionManager as unknown as { cwd: string }).cwd = ssh.remotePath;
      (session as unknown as { _cwd: string })._cwd = ssh.remotePath;
      session.setActiveToolsByName(session.getActiveToolNames());
    }
    let lastTurn: Promise<void> = Promise.resolve();
    let shuttingDown: Promise<void> | undefined;
    const currentModel = session.model
      ? { providerId: session.model.provider, modelId: session.model.id }
      : isolated && delegate
        ? { providerId: delegate.model.provider, modelId: delegate.model.id }
        : undefined;
    const preparePromptText = (text: string) =>
      expandUnloadedPromptTemplate(text, {
        cwd: input.cwd,
        agentDir,
        loadedNames: new Set(session.promptTemplates.map((template) => template.name)),
      });
    return {
      sessionId: input.sessionId,
      sessionFile: session.sessionFile ?? input.sessionFile,
      currentModel,
      listModels: () =>
        modelRuntime.getAvailableSnapshot().map((model) => ({
          providerId: model.provider,
          modelId: model.id,
          name: model.name,
        })),
      listSkills: () => session.resourceLoader.getSkills().skills.map(toPiSkillView),
      listSlashCommands: () => listSessionSlashCommands(session),
      get isStreaming() {
        return session.isStreaming;
      },
      get isIdle() {
        return session.isIdle;
      },
      takeMatchingPlanDecision: (text: string) => takePlanDecision(planDecisions, text),
      consumeDesignReviewOpened: () => {
        const opened = designReviewOpened;
        designReviewOpened = false;
        return opened;
      },
      prompt: (text, options) =>
        new Promise<boolean | "handled">((resolve, reject) => {
          const extension = registeredExtensionCommandText(text, listSessionSlashCommands(session));
          // 还在跑就不要进 Pi。裸 prompt 会抛 "already processing"，
          // 推迟执行的那次 rejection 接不住，进程会直接退出。
          // 扩展命令是 Pi 在跑的时候也立刻执行的，不走这条拒绝。
          if (session.isStreaming && !extension) {
            reject(new Error("pi prompt rejected: already streaming"));
            return;
          }
          const prepared = extension ?? preparePromptText(text);
          let settled = false;
          const pending = session
            .prompt(prepared, {
              ...(options?.images?.length ? { images: options.images } : {}),
              preflightResult: (result) => {
                settled = true;
                resolve(result === "handled" ? "handled" : true);
              },
            })
            .then(() => {
              if (!settled) resolve(true);
            })
            .catch((error: unknown) => {
              if (!settled) reject(error);
            });
          // 扩展命令不是模型回合。盖掉 lastTurn 会让还在跑的那一轮被当成已经结束。
          if (!extension) lastTurn = pending;
        }),
      recordExtensionOutput: (command, text) => {
        const body = text.trim();
        if (!body) return;
        session.sessionManager.appendCustomEntry("zcode-extension-output", {
          command,
          text: body,
        });
      },
      waitTurn: () => lastTurn,
      steer: async (text, images) => {
        await session.steer(preparePromptText(text), images);
      },
      followUp: async (text, images) => {
        await session.followUp(preparePromptText(text), images);
      },
      abort: () => session.abort(),
      continueAfterError: () => {
        if (session.isStreaming) return Promise.reject(new Error("still running"));
        const prepared = omitFailedAssistantForContinue({
          sessionManager: session.sessionManager,
          replaceMessages: (messages) => {
            session.agent.state.messages = messages;
          },
        });
        if (!prepared.ok) return Promise.reject(new Error("nothing to continue"));
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const stop = session.subscribe((event) => {
            if (event.type !== "agent_start" || settled) return;
            settled = true;
            stop();
            resolve();
          });
          const done = runContinueAfterModelError(
            session as unknown as Parameters<typeof runContinueAfterModelError>[0],
          );
          lastTurn = done;
          void done.then(
            () => {
              if (settled) return;
              settled = true;
              stop();
              reject(new Error("continue did not start"));
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              stop();
              reject(error);
            },
          );
        });
      },
      subscribeManagedProcesses: (listener) => processes?.subscribe(listener) ?? (() => undefined),
      killManagedProcess: (id: string) => processes?.kill(id) ?? Promise.resolve(false),
      readManagedProcessOutput: (workId: string) =>
        processes?.output(workId) ?? Promise.resolve({ kind: "unavailable" as const, workId }),
      compact: async () => {
        await session.compact();
      },
      contextUsage: () => readPiContextUsage(session, piCoding().formatSkillsForPrompt),
      captureAbandonedBranch: (request) => captureAbandonedBranch(session, request),
      summarizeAbandonedBranch: (captured, options) =>
        summarizeAbandonedBranch(
          session,
          captured as Parameters<typeof summarizeAbandonedBranch>[1],
          options,
        ),
      navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      abortBranchSummary: () => {
        session.abortBranchSummary();
      },
      get isCompacting() {
        return session.isCompacting;
      },
      readTree: () => readSessionTree(session.sessionManager),
      labelEntry: (id, label) => {
        labelSessionEntry(session.sessionManager, id, label);
      },
      deleteBranch: (entryId) => {
        deleteSessionBranch(session, entryId);
      },
      contextEvents: () => contextEventsOf(session.sessionManager),
      trimAssistantAtToolCall: (toolCallId: string) => {
        const manager = session.sessionManager;
        for (const entry of manager.getBranch()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          const trimmed = trimAssistantContentAtToolCall(entry.message.content, toolCallId);
          if (!trimmed || JSON.stringify(trimmed) === JSON.stringify(entry.message.content))
            continue;
          manager.appendContextEdit(entry.id, {
            content: trimmed as Extract<
              NonNullable<Parameters<typeof manager.appendContextEdit>[1]>,
              { content: unknown }
            >["content"],
          });
          // navigateTree 已经按未裁切的消息刷过模型上下文。这里再刷一次，下一次请求才停在这个工具。
          session.agent.state.messages = manager.buildSessionProjection().messages;
          return;
        }
      },
      resolveEntry: (id, hint) => resolveSessionEntry(session.sessionManager, id, hint),
      branchFrom: (entryId) => {
        const file = session.sessionFile;
        if (!file) throw new Error("session file missing");
        return branchPiSessionFile(file, entryId);
      },
      hasEntry: (id) => session.sessionManager.getEntry(id) != null,
      matchUserEntry: (text) =>
        resolveSessionEntry(session.sessionManager, "", { text, role: "user" }),
      setModel: async (provider, modelId, thought) => {
        if (isolated) {
          const next = { providerId: provider, modelId, thought };
          selections.set(session.sessionId, next);
          selections.set(input.sessionId, next);
          return true;
        }
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) return false;
        await session.setModel(model);
        if (thought) session.setThinkingLevel(mapThought(thought));
        return true;
      },
      setThinkingLevel: (level) => {
        session.setThinkingLevel(level);
        for (const key of [session.sessionId, input.sessionId]) {
          const current = selections.get(key);
          if (current) selections.set(key, { ...current, thought: level });
        }
      },
      get sessionName() {
        return session.sessionName;
      },
      setSessionName: (name) => {
        session.setSessionName(name);
      },
      setUiDesignMode: (enabled) => {
        uiDesign.setEnabled(enabled);
      },
      isUiDesignMode: () => uiDesign.isEnabled(),
      // 插件把 `plannotator` 的激活放在自己的 `session_start` 里，而绑 UI 是异步的；
      // 会话重放、阶段恢复也会重算激活列表。发送前用它把工具补回去。
      toolLoadout: {
        getToolDefinition: (name) => session.getToolDefinition(name),
        getActiveToolNames: () => session.getActiveToolNames(),
        setActiveToolsByName: (names) => session.setActiveToolsByName(names),
      },
      bindUi: async (ui) => {
        try {
          await session.bindExtensions({ uiContext: ui as never, mode: "rpc" });
        } catch {
          // 无 UI / 无 extension 时不挡会话创建
        }
      },
      subscribe: (listener) =>
        session.subscribe((event) => {
          const mapped = asPiEvent(event);
          if (mapped) listener(mapped);
        }),
      notePersistedMessage: (listener) => {
        persistedListeners.add(listener);
        return () => {
          persistedListeners.delete(listener);
        };
      },
      dispose: () => {
        backgroundSubagents.abortAll();
        return (shuttingDown ??= shutdownPiSession(session));
      },
    } satisfies PiSessionPort;
  };
}
