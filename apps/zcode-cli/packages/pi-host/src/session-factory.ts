import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
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
import { gateTool, type ToolPermissionCheck } from "./permission-gate.js";
import {
  createDelegateProvider,
  mapThought,
  type DelegateProvider,
  type ZCodeModelStreamPort,
} from "./model-delegate.js";
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
  type PiModelConfigView,
  type PiProviderDraft,
} from "./model-config-file.js";

const TOOL_NAMES =
  process.platform === "win32"
    ? ["read", "powershell", "edit", "write", "grep", "find", "ls"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls"];

function asPiEvent(event: unknown): PiHostEvent | null {
  if (!event || typeof event !== "object" || !("type" in event)) return null;
  return event as PiHostEvent;
}

function wrapCodingTools(cwd: string, check: ToolPermissionCheck | undefined) {
  const raw = [
    ...createCodingTools(cwd),
    ...(process.platform === "win32" ? [createPowerShellTool(cwd)] : []),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
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
}): Promise<PiModelConfigView & { discovered?: Array<{ id: string; name: string }> }> {
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

export function createSdkSessionFactory(options: {
  delegate?: DelegateProvider;
  stream?: ZCodeModelStreamPort["stream"];
  defaultSelection?: { providerId: string; modelId: string; thought?: string };
  agentDir?: string;
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
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
    });
    await resourceLoader.reload();
    const customTools = wrapCodingTools(input.cwd, input.checkPermission);
    const created = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      ...(isolated && delegate ? { model: delegate.model, thinkingLevel: "off" as const } : {}),
      modelRuntime,
      tools: customTools.map((tool) => tool.name).filter((name) => TOOL_NAMES.includes(name)),
      customTools: customTools as never,
      noTools: "builtin",
      resourceLoader,
      sessionManager: SessionManager.open(input.sessionFile, undefined, input.cwd),
      settingsManager,
    });
    const session = created.session;
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
