import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationDelta, DeliveryProfileName } from "@zcode/shared/zcode-protocol-v4";
import { CommandBridge } from "./command-bridge.js";
import { createHostExtensionUi } from "./extension-ui-bridge.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { HostQueue } from "./host-queue.js";
import { workspaceKey } from "./identity.js";
import { mapThought } from "./model-delegate.js";
import { PiToV4Projector } from "./projector.js";
import type { ToolPermissionCheck } from "./permission-gate.js";
import type { CreatePiSession, PiHostEvent, PiSessionPort } from "./types.js";

export interface HostedSession {
  readonly sessionId: string;
  readonly identity: string;
  readonly workspacePath: string;
  readonly sessionFile: string;
  readonly parentSessionId?: string;
  readonly workId?: string;
  readonly projector: PiToV4Projector;
  readonly queue: HostQueue;
  readonly ui: ExtensionUiHost;
  readonly bridge: CommandBridge;
  readonly viaRegistry: boolean;
  listModels(): Array<{ providerId: string; modelId: string }>;
  prompt(text: string): Promise<boolean>;
  waitTurn(): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  setModel(provider: string, modelId: string, thought?: string): Promise<void>;
  setThinkingLevel(level: string): void;
  setFeedback(entityId: string, feedback: "like" | "dislike" | null): void;
  requestConfirm(title: string, message: string): Promise<boolean>;
  dispose(): void;
  onDeltas(listener: (deltas: ConversationDelta[]) => void): () => void;
  onNotify(listener: (message: string, notifyType: "info" | "warning" | "error") => void): () => void;
}

export interface RegistryOptions {
  storageRoot: string;
  createSession: CreatePiSession;
  profile?: DeliveryProfileName;
  loadExtensions?: boolean;
  createToolPermission?: (hosted: HostedSession) => ToolPermissionCheck;
}

function encodeKey(identity: string): string {
  return Buffer.from(identity).toString("base64url");
}

export class HostSessionRegistry {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly children = new Map<string, Set<string>>();
  private readonly toolChecks = new Map<string, ToolPermissionCheck>();

  constructor(private readonly options: RegistryOptions) {}

  get(sessionId: string): HostedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async create(input: {
    workspaceIdentity?: string | null;
    workspacePath: string;
    sessionId?: string;
    parentSessionId?: string;
    viaRegistry?: boolean;
  }): Promise<HostedSession> {
    const identity = workspaceKey(input.workspaceIdentity, input.workspacePath);
    const sessionId = input.sessionId ?? randomUUID();
    const dir = join(this.options.storageRoot, "pi-host-sessions", encodeKey(identity));
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, "", { flag: "a" });
    const pi = await this.options.createSession({
      sessionId,
      cwd: input.workspacePath,
      sessionFile,
      parentSessionId: input.parentSessionId,
      loadExtensions: this.options.loadExtensions ?? true,
      checkPermission: async (request) => {
        const check = this.toolChecks.get(sessionId);
        if (!check) return "allow";
        return check(request);
      },
    });
    const hosted = this.wrap(pi, {
      sessionId,
      identity,
      workspacePath: input.workspacePath,
      sessionFile,
      parentSessionId: input.parentSessionId,
      viaRegistry: input.viaRegistry ?? Boolean(input.parentSessionId),
      workId: input.parentSessionId ? sessionId : undefined,
    });
    this.sessions.set(sessionId, hosted);
    if (this.options.createToolPermission) {
      this.toolChecks.set(sessionId, this.options.createToolPermission(hosted));
    }
    if (input.parentSessionId) {
      const set = this.children.get(input.parentSessionId) ?? new Set();
      set.add(sessionId);
      this.children.set(input.parentSessionId, set);
    }
    return hosted;
  }

  async spawn(parentId: string): Promise<HostedSession> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    return this.create({
      workspaceIdentity: parent.identity,
      workspacePath: parent.workspacePath,
      parentSessionId: parentId,
      viaRegistry: true,
    });
  }

  async fork(parentId: string, entryId: string): Promise<HostedSession> {
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error(`pi-host parent not found: ${parentId}`);
    const sessionId = randomUUID();
    const dir = join(this.options.storageRoot, "pi-host-sessions", encodeKey(parent.identity));
    await mkdir(dir, { recursive: true });
    const sessionFile = join(dir, `${sessionId}.jsonl`);
    await copyFile(parent.sessionFile, sessionFile);
    const pi = await this.options.createSession({
      sessionId,
      cwd: parent.workspacePath,
      sessionFile,
      loadExtensions: this.options.loadExtensions ?? true,
      checkPermission: async (request) => {
        const check = this.toolChecks.get(sessionId);
        if (!check) return "allow";
        return check(request);
      },
    });
    await pi.navigateTree?.(entryId);
    const hosted = this.wrap(pi, {
      sessionId,
      identity: parent.identity,
      workspacePath: parent.workspacePath,
      sessionFile,
      viaRegistry: true,
    });
    this.sessions.set(sessionId, hosted);
    if (this.options.createToolPermission) {
      this.toolChecks.set(sessionId, this.options.createToolPermission(hosted));
    }
    return hosted;
  }

  async abort(workId: string): Promise<boolean> {
    const child = this.sessions.get(workId);
    if (!child?.parentSessionId) return false;
    await child.abort();
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    hosted.dispose();
    this.sessions.delete(sessionId);
    this.toolChecks.delete(sessionId);
    await rm(hosted.sessionFile, { force: true });
  }

  async list(identity: string): Promise<Array<{ sessionId: string; sessionFile: string }>> {
    const dir = join(this.options.storageRoot, "pi-host-sessions", encodeKey(identity));
    try {
      const files = await readdir(dir);
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => ({ sessionId: file.replace(/\.jsonl$/u, ""), sessionFile: join(dir, file) }));
    } catch {
      return [];
    }
  }

  private wrap(
    pi: PiSessionPort,
    meta: {
      sessionId: string;
      identity: string;
      workspacePath: string;
      sessionFile: string;
      parentSessionId?: string;
      viaRegistry: boolean;
      workId?: string;
    },
  ): HostedSession {
    const queue = new HostQueue();
    const ui = new ExtensionUiHost();
    const projector = new PiToV4Projector(meta.sessionId, `epoch:${meta.sessionId}`, {
      profile: this.options.profile,
      viaRegistry: meta.viaRegistry,
      workId: meta.workId,
    });
    const bridge = new CommandBridge(pi, queue);
    const deltaListeners = new Set<(deltas: ConversationDelta[]) => void>();
    const notifyListeners = new Set<(message: string, notifyType: "info" | "warning" | "error") => void>();
    const emit = (deltas: ConversationDelta[]) => {
      if (deltas.length === 0) return;
      for (const listener of deltaListeners) listener(deltas);
    };
    const handleUi = (event: Extract<PiHostEvent, { type: "extension_ui_request" }>) => {
      const next = ui.handle(event);
      emit(projector.replaceInteractions(next.pending));
      emit(projector.replaceWidgets(next.widgets));
      emit(projector.replaceStatuses(next.statuses));
      for (const effect of next.sideEffects) {
        if (effect.kind === "notify") {
          for (const listener of notifyListeners) listener(effect.message, effect.notifyType);
        }
        if (effect.kind === "title") emit(projector.setTitle(effect.title, "generated"));
      }
    };
    const unsubscribe = pi.subscribe((event: PiHostEvent) => {
      try {
        if (event.type === "extension_ui_request") {
          handleUi(event);
          return;
        }
        emit(projector.apply(event));
        if (event.type === "agent_settled" || (event.type === "agent_end" && !event.willRetry)) {
          void bridge.drainNext().then((drained) => {
            if (drained) emit(projector.replaceQueue(queue.snapshot()));
          });
        }
      } catch (error) {
        console.error("pi-host event apply failed", event.type, error);
      }
    });
    void pi.bindUi?.(createHostExtensionUi(ui, handleUi));
    if (pi.currentModel) {
      projector.setConfig({
        provider: pi.currentModel.providerId,
        model: pi.currentModel.modelId,
        thought: "medium",
        thoughtLevels: ["off", "minimal", "low", "medium", "high"],
      });
    }
    return {
      sessionId: meta.sessionId,
      identity: meta.identity,
      workspacePath: meta.workspacePath,
      sessionFile: meta.sessionFile,
      parentSessionId: meta.parentSessionId,
      workId: meta.workId,
      projector,
      queue,
      ui,
      bridge,
      viaRegistry: meta.viaRegistry,
      listModels: () => pi.listModels?.() ?? (pi.currentModel ? [pi.currentModel] : []),
      prompt: (text) => pi.prompt(text),
      waitTurn: () => pi.waitTurn?.() ?? Promise.resolve(),
      abort: async () => {
        projector.markAborted();
        await pi.abort();
      },
      compact: () => pi.compact(),
      setModel: async (provider, modelId, thought) => {
        projector.setConfig({ provider, model: modelId, ...(thought ? { thought } : {}) });
        await pi.setModel?.(provider, modelId, thought);
      },
      setThinkingLevel: (level) => {
        projector.setConfig({ thought: level });
        pi.setThinkingLevel?.(mapThought(level));
      },
      navigateTree: async (targetId) => {
        await pi.navigateTree?.(targetId);
        emit(projector.truncateFrom(targetId));
      },
      setFeedback: (entityId, feedback) => {
        emit(projector.setFeedback(entityId, feedback));
      },
      requestConfirm: async (title, message) => {
        const id = `perm:${randomUUID()}`;
        const waiting = ui.wait(id);
        const next = ui.handle({
          type: "extension_ui_request",
          id,
          method: "confirm",
          title,
          message,
        });
        emit(projector.replaceInteractions(next.pending));
        const response = await waiting;
        emit(projector.replaceInteractions(ui.snapshot().pending));
        return "confirmed" in response && response.confirmed;
      },
      dispose: () => {
        unsubscribe();
        pi.dispose();
      },
      onDeltas: (listener) => {
        deltaListeners.add(listener);
        return () => {
          deltaListeners.delete(listener);
        };
      },
      onNotify: (listener) => {
        notifyListeners.add(listener);
        return () => {
          notifyListeners.delete(listener);
        };
      },
    };
  }
}
