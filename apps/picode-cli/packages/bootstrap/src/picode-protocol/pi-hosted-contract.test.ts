import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInMemorySessionEventStore,
  type TurnId,
  type SessionInfo,
  type SessionStorePort,
} from "@picode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@picode/core";
import { HostSessionRegistry, type PiHostEvent, type PiSessionPort } from "@picode/pi-host";
import { zcodeSessionStateSnapshotSchema } from "@picode/shared";
import { V4InteractionRegistry } from "../picode-protocol-v4/interaction-registry.js";
import { startPromptTurn } from "../picode-protocol-v4/commands/prompt-turn.js";
import {
  applyRequestedSessionConfig,
  modelConfigHandlers,
} from "../picode-protocol-v4/commands/handlers/model-config.js";
import { buildWorkspaceRef } from "./mapper.js";
import { bindHostedSession, createPiSessionRecord } from "./pi-session-record.js";
import {
  applyHostedWorkspaceFileRewind,
  previewHostedWorkspaceFileRewind,
} from "./hosted-file-rewind.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { readSession } from "./server-operations.js";
import { ZCodeProtocolAgentServer } from "./server.js";
import { interactionBackgroundHandlers } from "../picode-protocol-v4/commands/handlers/interaction-background.js";
import { queueHandlers } from "../picode-protocol-v4/commands/handlers/queue.js";
import { sessionFlowHandlers } from "../picode-protocol-v4/commands/handlers/session-flow.js";
import { sessionMgmtHandlers } from "../picode-protocol-v4/commands/handlers/session-mgmt.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { inputIntentMetadata } from "../picode-protocol-v4/commands/input-intent.js";
import { goalCompactHandlers } from "../picode-protocol-v4/commands/handlers/goal-compact.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-hosted-contract-"));
  const listeners = new Set<(event: PiHostEvent) => void>();
  const disposing = Promise.withResolvers<void>();
  const finishDisposing = Promise.withResolvers<void>();
  const finishTurn = Promise.withResolvers<void>();
  const prompts: string[] = [];
  let promptResult: boolean | "handled" = true;
  let currentModel = { providerId: "test", modelId: "initial" };
  let designMode = false;
  const modelSwitches: string[] = [];
  let disposeCalls = 0;
  const pi: PiSessionPort & { isIdle: boolean; isStreaming: boolean } = {
    sessionId: "hosted-contract",
    isStreaming: false,
    isIdle: true,
    get currentModel() {
      return currentModel;
    },
    async setModel(providerId, modelId) {
      modelSwitches.push(`${providerId}/${modelId}`);
      currentModel = { providerId, modelId };
      return true;
    },
    setThinkingLevel() {},
    setUiDesignMode(enabled) {
      designMode = enabled;
    },
    isUiDesignMode: () => designMode,
    async prompt(text) {
      prompts.push(text);
      return promptResult;
    },
    waitTurn: () => finishTurn.promise,
    listSlashCommands: () => [
      { name: "settings", source: "extension", description: "Settings", inputHint: "" },
    ],
    async steer() {},
    async followUp() {},
    async abort() {},
    async compact() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposeCalls++;
      disposing.resolve();
      await finishDisposing.promise;
    },
  };
  const registry = new HostSessionRegistry({
    storageRoot: join(root, "meta"),
    nativeSessionsRoot: join(root, "sessions"),
    createSession: async () => pi,
  });
  const context: ZCodeProtocolAgentServerContext = {
    appRuntimePreferences: { modelIoFullRetentionEnabled: false, offPeakToolEnabled: false },
    deps: {
      createZCodeApp() {
        throw new Error("Pi must not create the legacy Core app");
      },
      createSessionEventStore: () => createInMemorySessionEventStore(),
      workspaceHookPolicyProvider: new InMemoryWorkspaceHookPolicyProvider(),
    },
    notify() {},
    async requestClient() {
      throw new Error("Unexpected client request");
    },
    sessions: new Map(),
    v4Interactions: new V4InteractionRegistry(),
    piHost: registry,
  };
  const workspace = buildWorkspaceRef({ workspacePath: root });
  const hosted = await registry.create({
    sessionId: pi.sessionId,
    workspaceIdentity: workspace.workspaceIdentity?.trim() || workspace.workspacePath,
    workspacePath: root,
  });
  const record = await bindHostedSession(context, hosted, workspace);
  return {
    root,
    pi,
    hosted,
    record,
    context,
    registry,
    disposing,
    finishDisposing,
    finishTurn,
    prompts,
    modelSwitches,
    emit(event: PiHostEvent) {
      for (const listener of listeners) listener(event);
    },
    setPromptResult(result: boolean | "handled") {
      promptResult = result;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    async close() {
      finishTurn.resolve();
      finishDisposing.resolve();
      await hosted.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Pi protocol records expose the actual hosted session without a legacy app", async () => {
  const f = await fixture();
  try {
    assert.equal(Reflect.get(f.record, "hosted"), f.hosted);
    assert.equal(Object.hasOwn(f.record, "app"), false);
    assert.equal(f.context.sessions.get(f.hosted.sessionId), f.record);
  } finally {
    await f.close();
  }
});

test("Pi snapshot reads preserve both delivery profiles without a legacy runtime", async () => {
  const f = await fixture();
  try {
    f.hosted.setCollaborationMode("yolo");
    f.hosted.projector.apply({ type: "agent_start" });
    f.hosted.projector.setContextUsage(1234, 8192);
    for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
      const result = zcodeSessionStateSnapshotSchema.parse(
        await readSession(f.context, {
          sessionId: f.hosted.sessionId,
          deliveryKind,
        }),
      );
      assert.equal(result.projection.sessionId, f.hosted.sessionId);
      assert.equal(result.projection.mode, "yolo");
      assert.notEqual(result.projection.status, "idle");
      assert.deepEqual(result.runtime.contextUsage, { used: 1234, size: 8192 });
    }
  } finally {
    await f.close();
  }
});

test("resident eligibility follows hosted activity even when the projector is draft", async () => {
  const f = await fixture();
  try {
    const pool = createSessionResidentPoolHost(f.context);
    assert.equal(pool.readResidencyFacts(f.hosted.sessionId)?.hasResidencyBlockingWork, false);
    f.pi.isIdle = false;
    assert.equal(f.hosted.projector.getSnapshot().control.phase, "draft");
    assert.equal(pool.readResidencyFacts(f.hosted.sessionId)?.hasResidencyBlockingWork, true);
    f.pi.isIdle = true;
    assert.equal(pool.readResidencyFacts(f.hosted.sessionId)?.hasResidencyBlockingWork, false);
  } finally {
    await f.close();
  }
});

test("resident deactivation detaches immediately and awaits one hosted shutdown", async () => {
  const f = await fixture();
  try {
    let settled = false;
    const deactivation = createSessionResidentPoolHost(f.context)
      .deactivate(f.hosted.sessionId)
      .then(() => {
        settled = true;
      });
    await f.disposing.promise;
    assert.equal(f.context.sessions.has(f.hosted.sessionId), false);
    assert.equal(settled, false);
    assert.equal(f.disposeCalls, 1);
    f.finishDisposing.resolve();
    await deactivation;
    assert.equal(settled, true);
    assert.equal(f.disposeCalls, 1);
  } finally {
    await f.close();
  }
});

test("protocol shutdown waits for hosted resources after the client disconnects", async () => {
  const f = await fixture();
  const server = new ZCodeProtocolAgentServer(f.context.deps);
  const serverContext = Reflect.get(server, "context") as ZCodeProtocolAgentServerContext;
  serverContext.piHost = f.registry;
  await bindHostedSession(serverContext, f.hosted, f.record.workspace);
  try {
    let settled = false;
    const stopping = server.shutdown().then(() => {
      settled = true;
    });
    await f.disposing.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    f.finishDisposing.resolve();
    await stopping;
    assert.equal(f.disposeCalls, 1);
  } finally {
    f.finishDisposing.resolve();
    await server.shutdown();
    server.disposeProjections();
    await f.close();
  }
});

test("a Pi session that finishes creating after shutdown is disposed instead of registered", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let stopping = false;
  f.context.assertServing = () => {
    if (stopping) throw new Error("runtime stopping");
  };
  f.context.piHost = new HostSessionRegistry({
    storageRoot: join(f.root, "late-meta"),
    nativeSessionsRoot: join(f.root, "late-sessions"),
    async createSession() {
      entered.resolve();
      await release.promise;
      return f.pi;
    },
  });
  const creating = createPiSessionRecord(f.context, {
    workspace: f.record.workspace,
    sessionId: "late-session",
  });
  void creating.catch(() => entered.resolve());
  try {
    await entered.promise;
    stopping = true;
    f.finishDisposing.resolve();
    release.resolve();
    await assert.rejects(creating, /runtime stopping/);
    assert.equal(f.context.sessions.has("late-session"), false);
    assert.equal(f.disposeCalls, 1);
  } finally {
    release.resolve();
    f.finishDisposing.resolve();
    await creating.catch(() => undefined);
    await f.context.piHost?.get("late-session")?.dispose();
    await f.close();
  }
});

test("Pi prompt admission carries no fabricated turn result and waits for the actual turn", async () => {
  const f = await fixture();
  try {
    const mutations: string[] = [];
    const result = await startPromptTurn(
      {
        getRecord: () => f.record,
        afterLegacyStateMutation: async (_record, reason) => {
          mutations.push(reason ?? "");
        },
      },
      f.record,
      { content: "hello", inputId: "input-1" },
    );
    assert.equal(result.admission.kind, "started_turn");
    assert.notEqual(Reflect.get(result.admission, "turnId"), f.hosted.sessionId);
    assert.equal(f.record.residencyFinalizationCount, 1);
    assert.deepEqual(f.prompts, ["hello"]);
    assert.deepEqual(mutations, []);
    f.finishTurn.resolve();
    assert.equal(await result.completion, undefined);
    assert.equal(f.record.residencyFinalizationCount, 0);
    assert.deepEqual(mutations, ["prompt_completed"]);
  } finally {
    await f.close();
  }
});

test("busy Pi input retains its command identity in the existing hosted queue", async () => {
  const f = await fixture();
  try {
    f.pi.isIdle = false;
    f.pi.isStreaming = true;
    const result = await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "next question",
      inputId: "input-queued",
    });
    assert.equal(result.admission.kind, "queued");
    assert.equal(result.completion, undefined);
    assert.deepEqual(f.prompts, []);
    const items = f.hosted.queue.snapshot().items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, "next question");
    assert.equal(items[0]?.sourceCommandId, "input-queued");
    await assert.rejects(
      startPromptTurn({ getRecord: () => f.record }, f.record, {
        content: "next question",
        inputId: "input-queued",
        requireIdle: true,
      }),
      /requires an idle session/,
    );
    assert.equal(f.hosted.queue.snapshot().items.length, 1);
    assert.equal(f.record.residencyFinalizationCount ?? 0, 0);
  } finally {
    await f.close();
  }
});

test("manual Pi queue promotion sends the original input once and removes that item", async () => {
  const f = await fixture();
  try {
    f.pi.isIdle = false;
    f.pi.isStreaming = true;
    await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "queued message",
      inputId: "queued-original",
    });
    f.pi.isIdle = true;
    f.pi.isStreaming = false;
    await queueHandlers.sendQueuedNow(
      {
        getRecord: () => f.record,
        getQueueItem: (_sessionId, id) =>
          f.hosted.queue.snapshot().items.find((item) => item.queueItemId === id) ?? null,
      },
      {
        commandId: "promote-1",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "sendQueuedNow",
        payload: { queueItemId: "queued-original" },
        issuedAt: 1,
      },
    );
    assert.deepEqual(f.prompts, ["queued message"]);
    assert.equal(f.hosted.queue.snapshot().items.length, 0);
  } finally {
    await f.close();
  }
});

test("handled extension commands leave a Pi draft deferred and restore attribution", async () => {
  const f = await fixture();
  try {
    f.setPromptResult("handled");
    f.record.activeAutomationId = "previous";
    const result = await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "/settings",
      inputId: "extension-input",
      automationId: "automation-current",
    });
    assert.equal(result.admission.kind, "handled");
    assert.equal(result.completion, undefined);
    assert.equal(f.record.persistence, "deferred");
    assert.equal(f.record.activeAutomationId, "previous");
    assert.equal(f.record.residencyFinalizationCount ?? 0, 0);
  } finally {
    await f.close();
  }
});

test("Pi extension answers reach the pending hosted dialog", async () => {
  const f = await fixture();
  try {
    f.hosted.ui.handle({
      type: "extension_ui_request",
      id: "question-1",
      method: "select",
      title: "Choose",
      options: ["A", "B"],
    });
    const answer = f.hosted.ui.wait("question-1");
    await interactionBackgroundHandlers.resolveInteraction(
      { getRecord: () => f.record },
      {
        commandId: "answer-1",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "resolveInteraction",
        payload: { interactionId: "question-1", answer: { optionId: "A" } },
        issuedAt: 1,
      },
    );
    assert.equal(f.hosted.ui.snapshot().pending.length, 0);
    assert.deepEqual(await answer, { id: "question-1", value: "A" });
  } finally {
    await f.close();
  }
});

test("initial Pi configuration applies actual model, mode and design capabilities", async () => {
  const f = await fixture();
  try {
    await applyRequestedSessionConfig({ getRecord: () => f.record }, f.record, {
      modelSelection: { providerId: "test", modelId: "next" },
      mode: "yolo",
    });
    assert.equal(f.hosted.getCurrentModelSelection()?.modelId, "next");
    assert.deepEqual(f.modelSwitches, ["test/next"]);
    assert.equal(f.hosted.projector.getSnapshot().config.mode, "yolo");
    await applyRequestedSessionConfig({ getRecord: () => f.record }, f.record, {
      planEnabled: false,
    });
    assert.equal(f.hosted.ui.autoConfirm, true);
    await assert.rejects(
      applyRequestedSessionConfig({ getRecord: () => f.record }, f.record, { planEnabled: true }),
      /Core plan execution is unavailable/,
    );
    assert.equal(f.hosted.projector.getSnapshot().config.mode, "yolo");
    await modelConfigHandlers.setUiDesignMode(
      { getRecord: () => f.record },
      {
        commandId: "design-on",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "setUiDesignMode",
        payload: { enabled: true },
        issuedAt: 1,
      },
    );
    assert.equal(f.pi.isUiDesignMode?.(), true);
  } finally {
    await f.close();
  }
});

test("changing Pi collaboration mode preserves permission rules in persistent storage", async () => {
  const f = await fixture();
  try {
    let stored: SessionInfo = {
      id: f.hosted.sessionId as SessionInfo["id"],
      projectID: "test-project" as SessionInfo["projectID"],
      taskType: "interactive",
      slug: "hosted",
      directory: f.root,
      title: "Test",
      version: "1",
      permission: { mode: "build", allow: [{ toolName: "bash" }] },
      time: { created: 1, updated: 1 },
    };
    const store: Partial<SessionStorePort> = {
      async getSession() {
        return stored;
      },
      async updateSession(input) {
        stored = { ...stored, ...(input.permission ? { permission: input.permission } : {}) };
        return stored;
      },
    };
    f.context.deps.sessionStore = store as SessionStorePort;
    await applyRequestedSessionConfig({ getRecord: () => f.record }, f.record, { mode: "yolo" });
    assert.equal(stored.permission?.mode, "yolo");
    assert.deepEqual(stored.permission?.allow, [{ toolName: "bash" }]);
  } finally {
    await f.close();
  }
});

test("concurrent Pi model changes share one hosted-session mutation order", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const applyModel = f.pi.setModel!;
    const calls: string[] = [];
    f.pi.setModel = async (provider, model) => {
      calls.push(model);
      if (model === "first") {
        entered.resolve();
        await release.promise;
      }
      return applyModel(provider, model);
    };
    const host = { getRecord: () => f.record };
    const change = (model: string) =>
      modelConfigHandlers.switchModelConfig(host, {
        commandId: `model-${model}`,
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "switchModelConfig",
        payload: { provider: "test", model, thought: "" },
        issuedAt: 1,
      });
    const first = change("first");
    // A rejected first mutation must also settle the barrier so a broken Pi route fails promptly.
    void first.catch(() => entered.resolve());
    await entered.promise;
    const second = change("second");
    void second.catch(() => undefined);
    assert.deepEqual(calls, ["first"]);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(f.hosted.getCurrentModelSelection()?.modelId, "second");
  } finally {
    release.resolve();
    await f.close();
  }
});

test("Pi model noop is decided from the session rather than a stale display projection", async () => {
  const f = await fixture();
  try {
    f.hosted.projector.setConfig({ provider: "stale", model: "stale" });
    await assert.rejects(
      modelConfigHandlers.switchModelConfig(
        { getRecord: () => f.record },
        {
          commandId: "model-same",
          clientId: "test",
          sessionId: f.hosted.sessionId,
          type: "switchModelConfig",
          payload: { provider: "test", model: "initial", thought: "" },
          issuedAt: 1,
        },
      ),
      (error: unknown) =>
        error instanceof Error && Reflect.get(error, "reasonCode") === "config.unchanged",
    );
    assert.deepEqual(f.modelSwitches, []);
  } finally {
    await f.close();
  }
});

async function editedTurn(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, "edited.txt");
  await writeFile(path, "new\n");
  f.hosted.projector.apply({ type: "agent_start" });
  f.hosted.projector.apply({
    type: "tool_execution_start",
    toolCallId: "edit-1",
    toolName: "edit",
    args: { path, edits: [{ oldText: "old", newText: "new" }] },
  });
  f.hosted.projector.apply({
    type: "tool_execution_end",
    toolCallId: "edit-1",
    toolName: "edit",
    result: { content: [{ type: "text", text: "ok" }] },
  });
  f.hosted.projector.apply({ type: "agent_end" });
  const header = f.hosted.projector
    .getSnapshot()
    .rows.window.find((row) => row.kind === "turnHeader");
  assert.ok(header && header.kind === "turnHeader");
  return { path, targetTurnId: header.turnId as TurnId };
}

test("hosted file rewind applies bytes before committing the conversation", async () => {
  const f = await fixture();
  try {
    const { path, targetTurnId } = await editedTurn(f);
    let committed = false;
    const result = await applyHostedWorkspaceFileRewind(f.hosted, {
      targetTurnId,
      expandSuffix: true,
      async commitAfterApply() {
        assert.equal(await readFile(path, "utf8"), "old\n");
        committed = true;
      },
    });
    assert.equal(result.applied, true);
    assert.equal(committed, true);
    const header = f.hosted.projector
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");
    assert.equal(header?.kind === "turnHeader" ? header.fileChanges?.state : undefined, "reverted");
  } finally {
    await f.close();
  }
});

test("hosted file rewind compensates bytes when the conversation commit fails", async () => {
  const f = await fixture();
  try {
    const { path, targetTurnId } = await editedTurn(f);
    const result = await applyHostedWorkspaceFileRewind(f.hosted, {
      targetTurnId,
      expandSuffix: true,
      async commitAfterApply() {
        throw new Error("history cut failed");
      },
    });
    assert.equal(result.applied, false);
    assert.equal(result.response, "history cut failed");
    assert.equal(await readFile(path, "utf8"), "new\n");
    const header = f.hosted.projector
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");
    assert.notEqual(
      header?.kind === "turnHeader" ? header.fileChanges?.state : undefined,
      "reverted",
    );
  } finally {
    await f.close();
  }
});

test("hosted file rewind blocks external edits without committing", async () => {
  const f = await fixture();
  try {
    const { path, targetTurnId } = await editedTurn(f);
    await writeFile(path, "external\n");
    assert.equal(
      (await previewHostedWorkspaceFileRewind(f.hosted, { targetTurnId })).canApply,
      false,
    );
    const result = await applyHostedWorkspaceFileRewind(f.hosted, {
      targetTurnId,
      async commitAfterApply() {
        assert.fail("Unsafe rewind must not commit history");
      },
    });
    assert.equal(result.applied, false);
    assert.equal(await readFile(path, "utf8"), "external\n");
  } finally {
    await f.close();
  }
});

// 下列场景穿过命令入口，避免仅测操作 helper 时漏掉 legacy runtime 读取。
test("Pi sendText and rename command entry points use the hosted owner", async () => {
  const f = await fixture();
  try {
    const host = { getRecord: () => f.record };
    await sessionFlowHandlers.sendText(host, {
      commandId: "send-command",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "sendText",
      payload: { text: "from command" },
      issuedAt: 1,
    });
    assert.deepEqual(f.prompts, ["from command"]);
    await sessionMgmtHandlers.renameSession(host, {
      commandId: "rename-command",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "renameSession",
      payload: { title: "Custom title" },
      issuedAt: 2,
    });
    assert.equal(f.hosted.projector.getSnapshot().meta.title, "Custom title");
  } finally {
    await f.close();
  }
});

test("failed Pi queue promotion keeps the original item and auto-drain preference", async () => {
  const f = await fixture();
  try {
    f.pi.isIdle = false;
    await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "retain me",
      inputId: "failed-item",
    });
    f.pi.isIdle = true;
    const original = f.hosted.queue.snapshot().items[0];
    f.pi.prompt = async () => {
      throw new Error("prompt failed");
    };
    await assert.rejects(
      queueHandlers.sendQueuedNow(
        { getRecord: () => f.record },
        {
          commandId: "failed-promotion",
          clientId: "test",
          sessionId: f.hosted.sessionId,
          type: "sendQueuedNow",
          payload: { queueItemId: "failed-item" },
          issuedAt: 1,
        },
      ),
      /prompt failed/,
    );
    assert.deepEqual(f.hosted.queue.snapshot().items, [original]);
    assert.equal(f.hosted.queue.autoDrain, true);
  } finally {
    await f.close();
  }
});

test("Pi guide input steers the active session and retains its turn completion", async () => {
  const f = await fixture();
  try {
    const guided: string[] = [];
    f.pi.isIdle = false;
    f.pi.isStreaming = true;
    f.pi.steer = async (text) => {
      guided.push(text);
    };
    f.hosted.projector.apply({ type: "agent_start" });
    const result = await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "guide now",
      inputId: "guide-input",
      intent: inputIntentMetadata(
        {
          commandId: "guide-input",
          clientId: "test",
          sessionId: f.hosted.sessionId,
          type: "sendText",
          payload: { text: "guide now" },
          issuedAt: 1,
        },
        { text: "guide now", requestedDelivery: "guide" },
      ),
    });
    assert.equal(result.admission.kind, "started_turn");
    assert.deepEqual(guided, ["guide now"]);
    assert.equal(f.hosted.queue.snapshot().items.length, 0);
    f.finishTurn.resolve();
    await result.completion;
  } finally {
    await f.close();
  }
});

test("V4 gateway hydrates the real Pi model seed and dispatches a hosted command", async () => {
  const f = await fixture();
  const gateway = createConversationV4Gateway(f.context);
  f.context.v4Gateway = gateway;
  // fixture 先 bind 再建 gateway；生产的 bind 则立即向已有 gateway 回放 delta。
  const off = f.hosted.onDeltas((deltas) => gateway.ingestPiDeltas(f.hosted.sessionId, deltas));
  try {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      const dispatch = await gateway.subscribe({
        topic: `conversation/${f.hosted.sessionId}`,
        connectionId: clientMode,
        clientMode,
      });
      const frame = dispatch.initialFrame;
      assert.equal(frame?.payload.kind, "snapshot");
      if (frame?.payload.kind === "snapshot")
        assert.equal(frame.payload.snapshot.config.model, "initial");
    }
    const ack = await gateway.handleCommand({
      commandId: "gateway-send",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "sendText",
      payload: { text: "gateway prompt" },
      issuedAt: 1,
    });
    assert.equal(ack.status, "accepted", JSON.stringify(ack));
    assert.deepEqual(f.prompts, ["gateway prompt"]);
    const duplicate = await gateway.handleCommand({
      commandId: "gateway-send",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "sendText",
      payload: { text: "gateway prompt" },
      issuedAt: 1,
    });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(f.prompts.length, 1);
  } finally {
    off();
    f.finishTurn.resolve();
    await f.close();
    gateway.dispose();
  }
});

test("a failed direct hosted binding releases the session before returning the error", async () => {
  const f = await fixture();
  try {
    const failingStore: Partial<SessionStorePort> = {
      async getSession() {
        throw new Error("restore store failed");
      },
    };
    const context: ZCodeProtocolAgentServerContext = {
      ...f.context,
      sessions: new Map(),
      deps: { ...f.context.deps, sessionStore: failingStore as SessionStorePort },
    };
    f.finishDisposing.resolve();
    await assert.rejects(
      bindHostedSession(context, f.hosted, f.record.workspace),
      /restore store failed/,
    );
    assert.equal(f.disposeCalls, 1);
    assert.equal(context.sessions.size, 0);
  } finally {
    await f.close();
  }
});

test("V4 durable admission skips Pi extensions and creates the session before its first input", async () => {
  const f = await fixture();
  const order: string[] = [];
  let persisted: SessionInfo | null = null;
  const store: Partial<SessionStorePort> = {
    async getSession() {
      return persisted;
    },
    async messages() {
      return [];
    },
    async createSession(input) {
      order.push("session");
      persisted = {
        id: f.hosted.sessionId as SessionInfo["id"],
        projectID: "test-project" as SessionInfo["projectID"],
        taskType: "interactive",
        slug: "hosted",
        directory: f.root,
        title: input.title,
        version: "1",
        permission: input.permission,
        time: { created: 1, updated: 1 },
      };
      return persisted;
    },
    async saveSessionInput() {
      assert.ok(persisted, "session_input requires its session row");
      order.push("input");
    },
  };
  f.context.deps.sessionStore = store as SessionStorePort;
  const gateway = createConversationV4Gateway(f.context);
  f.context.v4Gateway = gateway;
  try {
    const extension = await gateway.handleCommand({
      commandId: "durable-extension",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "sendText",
      payload: { text: "/settings" },
      issuedAt: 1,
    });
    assert.equal(extension.status, "accepted", JSON.stringify(extension));
    assert.equal(f.record.persistence, "deferred");
    assert.deepEqual(order, []);
    const input = await gateway.handleCommand({
      commandId: "durable-first",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "sendText",
      payload: { text: "first durable input" },
      issuedAt: 2,
    });
    assert.equal(input.status, "accepted", JSON.stringify(input));
    assert.deepEqual(order, ["session", "input"]);
    assert.equal(f.record.persistence, "immediate");
  } finally {
    f.finishTurn.resolve();
    await f.close();
    gateway.dispose();
  }
});

test("Pi startNow keeps the existing queue behind the new input while abort settles", async () => {
  const f = await fixture();
  try {
    f.pi.isIdle = false;
    f.pi.isStreaming = true;
    f.emit({ type: "agent_start" });
    await startPromptTurn({ getRecord: () => f.record }, f.record, {
      content: "older queued input",
      inputId: "older-input",
    });
    f.pi.abort = async () => {
      f.pi.isIdle = true;
      f.pi.isStreaming = false;
      f.emit({ type: "agent_end" });
      f.finishTurn.resolve();
    };
    await sessionFlowHandlers.sendText(
      { getRecord: () => f.record },
      {
        commandId: "new-now",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "sendText",
        payload: { text: "new immediate input", requestedDelivery: "startNow" },
        issuedAt: 1,
      },
    );
    assert.deepEqual(f.prompts, ["new immediate input"]);
    assert.deepEqual(
      f.hosted.queue.snapshot().items.map((item) => item.sourceCommandId),
      ["older-input"],
    );
    assert.equal(f.hosted.queue.autoDrain, true);
  } finally {
    await f.close();
  }
});

test("Pi compact remains resident until Stop finishes its actual operation", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let aborted = 0;
  f.pi.compact = async () => {
    f.pi.isIdle = false;
    entered.resolve();
    await finish.promise;
    f.pi.isIdle = true;
  };
  f.pi.abort = async () => {
    aborted++;
    finish.resolve();
  };
  const host = {
    getRecord: () => f.record,
    afterLegacyStateMutation: async () => {
      completed.resolve();
    },
  };
  try {
    await goalCompactHandlers.compact(host, {
      commandId: "compact-now",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "compact",
      payload: {},
      issuedAt: 1,
    });
    await entered.promise;
    const controller = f.record.activeAbortController;
    assert.ok(controller);
    assert.equal(
      createSessionResidentPoolHost(f.context).readResidencyFacts(f.hosted.sessionId)
        ?.hasResidencyBlockingWork,
      true,
    );
    await sessionFlowHandlers.stop(host, {
      commandId: "stop-compact",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      type: "stop",
      payload: {},
      issuedAt: 2,
    });
    await completed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(aborted >= 1);
    assert.equal(controller.signal.aborted, true);
    assert.equal(f.record.activeAbortController, undefined);
    assert.equal(f.record.residencyFinalizationCount ?? 0, 0);
  } finally {
    finish.resolve();
    await f.close();
  }
});

test("shutdown waits for an in-flight Pi creation and its late dispose", async () => {
  const f = await fixture();
  const server = new ZCodeProtocolAgentServer(f.context.deps);
  const context = Reflect.get(server, "context") as ZCodeProtocolAgentServerContext;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  context.piHost = new HostSessionRegistry({
    storageRoot: join(f.root, "shutdown-meta"),
    nativeSessionsRoot: join(f.root, "shutdown-sessions"),
    async createSession() {
      entered.resolve();
      await release.promise;
      return f.pi;
    },
  });
  const creating = createPiSessionRecord(context, {
    workspace: f.record.workspace,
    sessionId: "shutdown-pending",
  });
  void creating.catch(() => undefined);
  let settled = false;
  try {
    await entered.promise;
    const closing = server.shutdown().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      "shutdown must drain factory work before closing shared resources",
    );
    release.resolve();
    await f.disposing.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "shutdown must await the late session's dispose");
    assert.equal(context.sessions.has("shutdown-pending"), false);
    f.finishDisposing.resolve();
    await closing;
    await assert.rejects(creating, /runtime is stopping/);
    assert.equal(f.disposeCalls, 1);
  } finally {
    release.resolve();
    f.finishDisposing.resolve();
    await creating.catch(() => undefined);
    await server.shutdown();
    server.disposeProjections();
    await f.close();
  }
});

test("shutdown also drains a hosted binding blocked in storage restoration", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store: Partial<SessionStorePort> = {
    async getSession() {
      entered.resolve();
      await release.promise;
      return null;
    },
  };
  const server = new ZCodeProtocolAgentServer({
    ...f.context.deps,
    sessionStore: store as SessionStorePort,
  });
  const context = Reflect.get(server, "context") as ZCodeProtocolAgentServerContext;
  const binding = bindHostedSession(context, f.hosted, f.record.workspace);
  void binding.catch(() => undefined);
  let settled = false;
  try {
    await entered.promise;
    const closing = server.shutdown().then(() => {
      settled = true;
    });
    await f.disposing.promise;
    f.finishDisposing.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "storage restoration must settle before shared storage closes");
    release.resolve();
    await assert.rejects(binding, /runtime is stopping/);
    await closing;
    assert.equal(context.sessions.size, 0);
    assert.equal(f.disposeCalls, 1);
  } finally {
    release.resolve();
    f.finishDisposing.resolve();
    await binding.catch(() => undefined);
    await server.shutdown();
    server.disposeProjections();
    await f.close();
  }
});

function promotionEnvelope(sessionId: string, queueItemId: string, commandId: string) {
  return {
    commandId,
    clientId: "test",
    sessionId,
    type: "sendQueuedNow" as const,
    payload: { queueItemId },
    issuedAt: 1,
  };
}

test("Pi promotion rejects busy after model checks without enqueue or guide", async () => {
  const f = await fixture();
  try {
    const item = f.hosted.queue.createItem({
      sourceCommandId: "busy-promotion",
      clientId: "test",
      text: "original",
      admitted: "guide",
    });
    f.hosted.queue.enqueue(item);
    let steers = 0;
    f.pi.steer = async () => {
      steers++;
    };
    await assert.rejects(
      queueHandlers.sendQueuedNow(
        {
          getRecord: () => f.record,
          async ensureModelReady() {
            f.pi.isIdle = false;
            f.pi.isStreaming = true;
          },
        },
        promotionEnvelope(f.hosted.sessionId, item.queueItemId, "promote-busy"),
      ),
    );
    assert.deepEqual(f.hosted.queue.snapshot().items, [item]);
    assert.deepEqual(f.prompts, []);
    assert.equal(steers, 0);
  } finally {
    await f.close();
  }
});

test(
  "Pi overlapping manual promotions cannot send one item twice or pause auto-drain",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const item = f.hosted.queue.createItem({
      sourceCommandId: "overlap",
      clientId: "test",
      text: "once",
      admitted: "queue",
    });
    f.hosted.queue.enqueue(item);
    const host = {
      getRecord: () => f.record,
      async ensureModelReady() {
        entered.resolve();
        await release.promise;
      },
    };
    const first = queueHandlers.sendQueuedNow(
      host,
      promotionEnvelope(f.hosted.sessionId, item.queueItemId, "first"),
    );
    void first.catch(() => undefined);
    try {
      await entered.promise;
      const second = queueHandlers.sendQueuedNow(
        host,
        promotionEnvelope(f.hosted.sessionId, item.queueItemId, "second"),
      );
      void second.catch(() => undefined);
      // 放行模型边界后第二个提升必须被 claim 拒绝，不能继续使用已读取的旧项。
      release.resolve();
      await first;
      await assert.rejects(second, { reasonCode: "guard.queuePromotionBusy" });
      assert.deepEqual(f.prompts, ["once"]);
      assert.equal(f.hosted.queue.autoDrain, true);
      assert.equal(f.hosted.queue.snapshot().items.length, 0);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await f.close();
    }
  },
);

test(
  "Pi promotion cannot overtake a Registry drain already loading its model",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.pi.setModel = async () => {
      entered.resolve();
      await release.promise;
      return true;
    };
    const original = f.hosted.queue.createItem({
      sourceCommandId: "draining",
      clientId: "test",
      text: "first",
      admitted: "queue",
      modelSelection: { providerId: "test", modelId: "other" },
    });
    const next = f.hosted.queue.createItem({
      sourceCommandId: "waiting",
      clientId: "test",
      text: "second",
      admitted: "queue",
    });
    f.hosted.queue.enqueue(original);
    f.hosted.queue.enqueue(next);
    const draining = f.hosted.bridge.drainNext();
    void draining.catch(() => undefined);
    try {
      await entered.promise;
      await assert.rejects(
        queueHandlers.sendQueuedNow(
          { getRecord: () => f.record },
          promotionEnvelope(f.hosted.sessionId, next.queueItemId, "overlap-drain"),
        ),
        { reasonCode: "guard.queuePromotionBusy" },
      );
      assert.deepEqual(f.prompts, []);
      assert.deepEqual(f.hosted.queue.snapshot().items, [next]);
      release.resolve();
      await draining;
      assert.deepEqual(f.prompts, ["first"]);
      assert.equal(f.hosted.queue.autoDrain, true);
    } finally {
      release.resolve();
      await draining.catch(() => undefined);
      await f.close();
    }
  },
);

test(
  "Pi failed compact remains a held FIFO barrier after promotion releases",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const failed = Promise.withResolvers<void>();
    const observed: boolean[] = [];
    try {
      const compact = {
        ...f.hosted.queue.createItem({
          sourceCommandId: "compact-fails",
          clientId: "test",
          text: "/compact",
          admitted: "queue",
        }),
        kind: "compact" as const,
      };
      const next = f.hosted.queue.createItem({
        sourceCommandId: "after-compact",
        clientId: "test",
        text: "must remain held",
        admitted: "queue",
      });
      f.hosted.queue.enqueue(compact);
      f.hosted.queue.enqueue(next);
      f.pi.compact = async () => {
        throw new Error("compact failure");
      };
      await queueHandlers.sendQueuedNow(
        {
          getRecord: () => f.record,
          getQueueLength: () => f.hosted.queue.snapshot().items.length,
          async afterLegacyStateMutation(_record, reason) {
            if (reason === "queue_promoted" || reason === "session_compact_failed")
              observed.push(f.hosted.queue.autoDrain);
            if (reason === "session_compact_failed") failed.resolve();
          },
        },
        promotionEnvelope(f.hosted.sessionId, compact.queueItemId, "promote-compact"),
      );
      await failed.promise;
      assert.deepEqual(f.hosted.queue.snapshot().items, [next]);
      assert.equal(f.hosted.queue.autoDrain, false);
      assert.ok(observed.length >= 1);
      assert.ok(observed.every((value) => value === false));
      assert.equal(await f.hosted.bridge.drainNext(), false);
      assert.deepEqual(f.prompts, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "V4 reevaluates the current queue when an in-flight consumer releases",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const gateway = createConversationV4Gateway(f.context);
    f.context.v4Gateway = gateway;
    const prompted = Promise.withResolvers<void>();
    const original = f.hosted.queue.createItem({
      sourceCommandId: "already-consumed",
      clientId: "test",
      text: "old head",
      admitted: "queue",
    });
    const next = f.hosted.queue.createItem({
      sourceCommandId: "ready-after-release",
      clientId: "test",
      text: "current head",
      admitted: "queue",
    });
    f.hosted.queue.enqueue(original);
    f.hosted.queue.enqueue(next);
    f.hosted.projector.replaceQueue(f.hosted.queue.snapshot());
    const consumer = f.hosted.queue.tryAcquireConsumer();
    assert.ok(consumer);
    f.pi.prompt = async (text) => {
      f.prompts.push(text);
      prompted.resolve();
      return true;
    };
    try {
      const subscribed = await gateway.subscribe({
        topic: `conversation/${f.hosted.sessionId}`,
        connectionId: "consumer-ready",
        clientMode: "desktop-continuous",
      });
      const frame = subscribed.initialFrame;
      assert.ok(frame?.payload.kind === "snapshot");
      const ack = await gateway.handleCommand({
        baseRevision: frame.payload.snapshot.revision,
        baseLogEpoch: frame.payload.snapshot.logEpoch,
        commandId: "enable-while-consuming",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "setAutoDrain",
        payload: { autoDrain: true },
        issuedAt: 1,
      });
      assert.equal(ack.status, "accepted", JSON.stringify(ack));
      assert.deepEqual(f.prompts, []);
      // 在途 Registry 的 shift 尚未同步到 publisher；释放后必须读 owner 当前队首。
      f.hosted.queue.remove(original.queueItemId);
      consumer.release();
      await prompted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(f.prompts, ["current head"]);
      assert.deepEqual(f.hosted.queue.snapshot().items, []);
      assert.equal(f.hosted.queue.autoDrain, true);
    } finally {
      consumer.release();
      f.finishTurn.resolve();
      gateway.dispose();
      await f.close();
    }
  },
);

test(
  "Pi queue mutations cannot change a promotion paused in model checks",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const item = f.hosted.queue.createItem({
      sourceCommandId: "claimed",
      clientId: "test",
      text: "original",
      admitted: "queue",
    });
    f.hosted.queue.enqueue(item);
    const host = {
      getRecord: () => f.record,
      async ensureModelReady() {
        entered.resolve();
        await release.promise;
      },
    };
    const promoting = queueHandlers.sendQueuedNow(
      host,
      promotionEnvelope(f.hosted.sessionId, item.queueItemId, "claim-owner"),
    );
    void promoting.catch(() => undefined);
    const base = {
      commandId: "mutate",
      clientId: "test",
      sessionId: f.hosted.sessionId,
      issuedAt: 1,
    };
    try {
      await entered.promise;
      await assert.rejects(
        queueHandlers.deleteQueueItem(host, {
          ...base,
          type: "deleteQueueItem",
          payload: { queueItemId: item.queueItemId },
        }),
        { reasonCode: "guard.queueItemReserved" },
      );
      await assert.rejects(
        queueHandlers.editQueueItem(host, {
          ...base,
          type: "editQueueItem",
          payload: { queueItemId: item.queueItemId, newText: "changed" },
        }),
        { reasonCode: "guard.queueItemReserved" },
      );
      await assert.rejects(
        queueHandlers.reorderQueueItem(host, {
          ...base,
          type: "reorderQueueItem",
          payload: { queueItemId: item.queueItemId, beforeQueueItemId: null },
        }),
        { reasonCode: "guard.queueItemReserved" },
      );
      assert.deepEqual(f.hosted.queue.snapshot().items, [item]);
      release.resolve();
      await promoting;
      assert.deepEqual(f.prompts, ["original"]);
    } finally {
      release.resolve();
      await promoting.catch(() => undefined);
      await f.close();
    }
  },
);

test("same-model Pi thought changes publish a real config delta", async () => {
  const f = await fixture();
  const thoughts: string[] = [];
  const off = f.hosted.onDeltas((deltas) => {
    for (const delta of deltas)
      if (delta.op === "state.updated" && delta.patch.config?.thought)
        thoughts.push(delta.patch.config.thought);
  });
  try {
    f.hosted.projector.setConfig({ thought: "low", thoughtLevels: ["low", "high"] });
    thoughts.length = 0;
    await modelConfigHandlers.switchModelConfig(
      { getRecord: () => f.record },
      {
        commandId: "thought-only",
        clientId: "test",
        sessionId: f.hosted.sessionId,
        type: "switchModelConfig",
        payload: { provider: "test", model: "initial", thought: "high" },
        issuedAt: 1,
      },
    );
    assert.equal(f.hosted.projector.getSnapshot().config.thought, "high");
    assert.deepEqual(thoughts, ["high"]);
    assert.deepEqual(f.modelSwitches, []);
  } finally {
    off();
    await f.close();
  }
});

test("Pi snapshot history hydration preserves existing rows and feedback", async () => {
  const f = await fixture();
  try {
    const history = [
      {
        type: "session",
        id: f.hosted.sessionId,
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: f.root,
      },
      {
        type: "message",
        id: "history-user",
        timestamp: "2026-01-02T03:04:06.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "message",
        id: "history-answer",
        timestamp: "2026-01-02T03:04:07.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await writeFile(f.hosted.sessionFile, history);
    await readSession(f.context, { sessionId: f.hosted.sessionId });
    const answer = f.hosted.projector
      .getSnapshot()
      .rows.window.find((row) => row.kind === "assistantText");
    assert.ok(answer && answer.kind === "assistantText" && answer.entityId);
    f.hosted.setFeedback(answer.entityId, "like");
    const before = structuredClone(f.hosted.projector.getSnapshot().rows.window);
    assert.ok(before.some((row) => row.kind === "assistantText" && row.feedback === "like"));
    await readSession(f.context, { sessionId: f.hosted.sessionId });
    const after = f.hosted.projector.getSnapshot().rows.window;
    assert.deepEqual(
      after,
      before,
      "snapshot reads must not rebuild already restored conversation rows",
    );
    const preserved = after.find((row) => row.kind === "assistantText");
    assert.ok(preserved && preserved.kind === "assistantText");
    assert.equal(preserved.feedback, "like");
  } finally {
    await f.close();
  }
});
