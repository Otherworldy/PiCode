import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  createCodingTools,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createCapabilityTools,
  runZcodeSubagent,
  type PiCapabilityPorts,
} from "./host-capabilities.js";
import { gateTool, type ToolPermissionCheck } from "./permission-gate.js";
import {
  createDelegateProvider,
  mapThought,
  type DelegateProvider,
  type ZCodeModelStreamPort,
} from "./model-delegate.js";
import { readProcessSshRemoteSpec, sshCodingToolOptions, sshSearchText } from "./ssh-remote.js";
import type { CreatePiSession, PiHostEvent, PiSessionPort } from "./types.js";
import {
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

function asPiEvent(event: unknown): PiHostEvent | null {
  if (!event || typeof event !== "object" || !("type" in event)) return null;
  return event as PiHostEvent;
}

function wrapCodingTools(cwd: string, check: ToolPermissionCheck | undefined) {
  const ssh = readProcessSshRemoteSpec(cwd);
  const raw = [
    ...createCodingTools(cwd, ssh ? sshCodingToolOptions(ssh) : undefined),
    ...(ssh
      ? []
      : [
          ...(process.platform === "win32" ? [createPowerShellTool(cwd)] : []),
          createGrepTool(cwd),
          createFindTool(cwd),
          createLsTool(cwd),
        ]),
  ];
  const seen = new Set<string>();
  return raw
    .filter((tool) => {
      if (seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    })
    .map((tool) => ({
      ...tool,
      execute: async (
        toolCallId: string,
        params: never,
        signal?: AbortSignal,
        onUpdate?: never,
      ) => {
        await gateTool(check, tool.name, params);
        if (ssh && (tool.name === "grep" || tool.name === "find")) {
          return sshSearchText(
            tool.name,
            params as { pattern?: string; path?: string; glob?: string; limit?: number },
            ssh,
            signal,
          );
        }
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    }));
}

async function createIsolatedRuntime(delegate: DelegateProvider): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
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
  productionRuntime ??= ModelRuntime.create();
  return productionRuntime;
}

function thoughtLevelsOf(model: { thinkingLevelMap?: Record<string, unknown> }): string[] {
  const keys = Object.keys(model.thinkingLevelMap ?? {});
  return keys.length > 0 ? keys : ["off", "low", "medium", "high"];
}

export async function listPiCatalog(): Promise<{
  models: Array<{ providerId: string; modelId: string; name?: string; thoughtLevels: string[] }>;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThought?: string;
}> {
  const runtime = await getProductionModelRuntime();
  const settings = SettingsManager.create(process.cwd(), getAgentDir());
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
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(process.cwd(), agentDir);
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

function sessionFileHasContent(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export function branchPiSessionFile(
  sessionFile: string,
  entryId: string,
): { sessionId: string; sessionFile: string } {
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  if (manager.getEntry(entryId) == null) throw new Error(`Entry ${entryId} not found`);
  const branched = manager.createBranchedSession(entryId);
  if (!branched) throw new Error(`Entry ${entryId} not found`);
  return { sessionId: manager.getSessionId(), sessionFile: branched };
}

function openOrCreateSession(input: {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  parentSessionId?: string;
}) {
  if (sessionFileHasContent(input.sessionFile)) {
    return SessionManager.open(input.sessionFile, undefined, input.cwd);
  }
  return SessionManager.create(input.cwd, dirname(input.sessionFile), {
    id: input.sessionId,
    parentSession: input.parentSessionId,
  });
}

export function createSdkSessionFactory(options: {
  delegate?: DelegateProvider;
  stream?: ZCodeModelStreamPort["stream"];
  defaultSelection?: { providerId: string; modelId: string; thought?: string };
  agentDir?: string;
  capabilities?: PiCapabilityPorts;
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
    if (options.modelRuntime) return Promise.resolve(options.modelRuntime);
    runtimePromise ??=
      isolated && delegate ? createIsolatedRuntime(delegate) : getProductionModelRuntime();
    return runtimePromise;
  };

  return async (input) => {
    const modelRuntime = await runtime();
    const agentDir =
      options.agentDir ??
      (input.loadExtensions ? getAgentDir() : join(tmpdir(), "zcode-pi-no-ext"));
    const settingsManager = isolated
      ? SettingsManager.inMemory({ retry: { enabled: false } })
      : SettingsManager.create(input.cwd, agentDir);
    const ssh = readProcessSshRemoteSpec(input.cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      additionalSkillPaths: options.skillPaths?.(input.cwd) ?? [],
      ...(ssh
        ? {
            appendSystemPrompt: [
              `This session is an SSH workspace on a remote POSIX host. The working directory is ${ssh.remotePath}. Use POSIX paths and a POSIX shell. Do not use cmd, PowerShell, or Windows drive paths.`,
            ],
          }
        : {}),
    });
    await resourceLoader.reload();
    const customTools = wrapCodingTools(input.cwd, input.checkPermission);
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
          reservedNames: customTools.map((tool) => tool.name),
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
              modelRuntime,
              model: live?.model,
              thinkingLevel: live?.thinkingLevel,
              agentDir,
              codingTools: customTools,
            }),
        })
      : [];
    const created = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      ...(isolated && delegate ? { model: delegate.model, thinkingLevel: "off" as const } : {}),
      modelRuntime,
      customTools: [...customTools, ...capabilityTools] as never,
      // noTools=builtin 关掉 Pi 同名工具。不传白名单，以免把 extension 工具全关掉。
      // 插件自带的 subagent 与 ZCode 代理定义冲突，主会话禁用它。
      noTools: "builtin",
      ...(options.capabilities ? { excludeTools: ["subagent"] } : {}),
      resourceLoader,
      sessionManager: openOrCreateSession(input),
      settingsManager,
    });
    live = created.session;
    const session = created.session;
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
      get isStreaming() {
        return session.isStreaming;
      },
      prompt: (text) =>
        new Promise<boolean>((resolve, reject) => {
          let settled = false;
          lastTurn = session
            .prompt(text, {
              preflightResult: (ok) => {
                settled = true;
                resolve(ok);
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
      steer: (text) => session.steer(text),
      followUp: (text) => session.followUp(text),
      abort: () => session.abort(),
      compact: async () => {
        await session.compact();
      },
      navigateTree: (targetId) => session.navigateTree(targetId),
      branchFrom: (entryId) => {
        const file = session.sessionFile;
        if (!file) throw new Error("session file missing");
        return branchPiSessionFile(file, entryId);
      },
      hasEntry: (id) => session.sessionManager.getEntry(id) != null,
      matchUserEntry: (text) => {
        const wanted = text.trim();
        if (!wanted) return undefined;
        const entries = session.sessionManager.getEntries();
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (!entry || entry.type !== "message" || entry.message.role !== "user") continue;
          const content = entry.message.content;
          const value = Array.isArray(content)
            ? content
                .map((part) =>
                  part && typeof part === "object" && "text" in part && typeof part.text === "string"
                    ? part.text
                    : "",
                )
                .join("")
            : typeof content === "string"
              ? content
              : "";
          if (value.trim() === wanted) return entry.id;
        }
        return undefined;
      },
      setModel: async (provider, modelId, thought) => {
        if (isolated) {
          const next = { providerId: provider, modelId, thought };
          selections.set(session.sessionId, next);
          selections.set(input.sessionId, next);
          return;
        }
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) return;
        await session.setModel(model);
        if (thought) session.setThinkingLevel(mapThought(thought));
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
