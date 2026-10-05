import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import { createPiProcessBridge } from "./pi-process-bridge.js";
import { applyZcodePluginPlan, zcodePluginLoaderExtras } from "./pi-plugins.js";
import { listSessionSlashCommands } from "./pi-slash-commands.js";
import { toPiSkillView } from "./pi-skills.js";
import { branchPiSessionFile, openOrCreateSession } from "./session-files.js";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createCapabilityTools,
  runZcodeSubagent,
  type PiCapabilityPorts,
} from "./host-capabilities.js";
import { readPiContextUsage } from "./context-breakdown.js";
import { createPermissionExtension } from "./permission-gate.js";
import {
  contextEventsOf,
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
import { readProcessSshRemoteSpec, sshCodingToolOptions, sshWorkspacePrompt } from "./ssh-remote.js";
import {
  prepareContinueMessages,
  runContinueAfterModelError,
} from "./continue-after-error.js";
import {
  createZcodeMcpTransport,
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
  productionRuntime ??=
    ensurePiSdk().then(async () => {
      const coding = piCoding();
      await alignStoredModelApi(coding.getAgentDir());
      return coding.ModelRuntime.create();
    });
  return productionRuntime;
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

export async function listPiCatalog(): Promise<{
  models: Array<{ providerId: string; modelId: string; name?: string; thoughtLevels: string[] }>;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThought?: string;
}> {
  const runtime = await getProductionModelRuntime();
  const settings = piCoding().SettingsManager.create(process.cwd(), piCoding().getAgentDir());
  return {
    models: runtime.getAvailableSnapshot().map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      thoughtLevels: thoughtLevelsOf(model),
    })),
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
}): Promise<PiModelConfigView & { discovered?: PiDiscoveredModel[] }> {
  await ensurePiSdk();
  const agentDir = piCoding().getAgentDir();
  const settings = piCoding().SettingsManager.create(process.cwd(), agentDir);
  let file = await loadModelsJson(agentDir);

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
  } else if (input.action === "setDefault" && input.defaultProvider && input.defaultModel) {
    settings.setDefaultModelAndProvider(input.defaultProvider, input.defaultModel);
    await settings.flush();
  } else if (input.action === "discover") {
    const baseUrl = input.provider?.baseUrl ?? "";
    const apiKey = input.provider?.apiKey || storedApiKey(file, input.providerId ?? input.provider?.id ?? "");
    const discovered = await discoverPiModels(baseUrl, apiKey);
    return {
      ...toPiModelConfigView(file, {
        defaultProvider: settings.getDefaultProvider(),
        defaultModel: settings.getDefaultModel(),
      }),
      discovered,
    };
  }

  return toPiModelConfigView(file, {
    defaultProvider: settings.getDefaultProvider(),
    defaultModel: settings.getDefaultModel(),
  });
}

export { branchPiSessionFile };

const BUILTIN_SEARCH_TOOLS = ["grep", "find", "ls"] as const;

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

export function createSdkSessionFactory(options: {
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
} = {}): CreatePiSession {
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
    runtimePromise ??=
      ensurePiSdk().then(() =>
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
    const pluginExtras = !isolated && input.loadExtensions
      ? await zcodePluginLoaderExtras(input.cwd, agentDir, options.skillPaths?.(input.cwd) ?? [])
      : undefined;
    const processes = !isolated && input.loadExtensions ? createPiProcessBridge() : undefined;
    const usePiMcp = !isolated && input.loadExtensions && !input.parentSessionId;
    const mcpRuntime = usePiMcp
      ? registerableMcpServers(
          (await options.mcpCompat?.runtimeServers({ cwd: input.cwd, sessionId: input.sessionId })) ?? [],
        )
      : [];
    const codingForMcp = usePiMcp ? piCoding() : undefined;
    const resourceLoader = new (piCoding().DefaultResourceLoader)({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      ...(pluginExtras?.loader ?? { additionalSkillPaths: options.skillPaths?.(input.cwd) ?? [] }),
      extensionFactories: [
        createPermissionExtension(input.checkPermission),
        ...(usePiMcp && codingForMcp
          ? [
              (pi: { registerMcpServer(name: string, config: (typeof mcpRuntime)[number]["config"]): void }) => {
                for (const server of mcpRuntime) pi.registerMcpServer(server.name, server.config);
              },
              codingForMcp.createCodemodeExtension(),
              codingForMcp.createToolSearchExtension(),
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
      ...(ssh ? { appendSystemPrompt: [sshWorkspacePrompt(ssh)] } : {}),
    });
    await resourceLoader.reload();
    if (pluginExtras) applyZcodePluginPlan(resourceLoader, pluginExtras.plan);
    // 本地不塞 read/bash/grep/find。Pi 自己有，扩展（pi-fff）才能按原名换掉。
    // SSH 必须换成远端读写，否则这些工具打到本机盘。
    const sshTools = ssh ? piCoding().createCodingTools(input.cwd, sshCodingToolOptions(ssh)) : [];
    let live:
      | {
          model?: CreateAgentSessionOptions["model"];
          thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
          sessionFile?: string;
        }
      | undefined;
    const capabilityTools = options.capabilities
      ? await createCapabilityTools({
          cwd: input.cwd,
          ports: options.capabilities,
          check: input.checkPermission,
          sessionId: input.sessionId,
          runSubagent: (profile, task, signal) =>
            runZcodeSubagent({
              cwd: input.cwd,
              // Pi 落盘文件名带自己的时间戳，和注册表预先拼的路径不是同一个。
              // 子会话必须写在真实父文件旁边，目录页才扫得到。
              parentSessionFile: live?.sessionFile || input.sessionFile,
              profile,
              task,
              signal,
              check: input.checkPermission,
              modelRuntime,
              model: live?.model,
              thinkingLevel: live?.thinkingLevel,
              agentDir,
              ...(sshTools.length > 0 ? { sshTools } : {}),
            }),
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
    const currentModel = session.model
      ? { providerId: session.model.provider, modelId: session.model.id }
      : isolated && delegate
        ? { providerId: delegate.model.provider, modelId: delegate.model.id }
        : undefined;
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
      prompt: (text, options) =>
        new Promise<boolean>((resolve, reject) => {
          let settled = false;
          lastTurn = session
            .prompt(text, {
              ...(options?.images?.length ? { images: options.images } : {}),
              preflightResult: () => {
                settled = true;
                resolve(true);
              },
            })
            .then(() => {
              if (!settled) resolve(true);
            })
            .catch((error) => {
              if (!settled) reject(error);
            });
        }),
      waitTurn: () => lastTurn,
      steer: async (text, images) => {
        await session.steer(text, images);
      },
      followUp: async (text, images) => {
        await session.followUp(text, images);
      },
      abort: () => session.abort(),
      continueAfterError: () => {
        if (session.isStreaming) return Promise.reject(new Error("still running"));
        const prepared = prepareContinueMessages(session.agent.state.messages);
        if (!prepared.ok) return Promise.reject(new Error("nothing to continue"));
        session.agent.state.messages = prepared.messages;
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
      resolveEntry: (id, hint) => resolveSessionEntry(session.sessionManager, id, hint),
      branchFrom: (entryId) => {
        const file = session.sessionFile;
        if (!file) throw new Error("session file missing");
        return branchPiSessionFile(file, entryId);
      },
      hasEntry: (id) => session.sessionManager.getEntry(id) != null,
      matchUserEntry: (text) => resolveSessionEntry(session.sessionManager, "", { text, role: "user" }),
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
      dispose: () => session.dispose(),
    } satisfies PiSessionPort;
  };
}
