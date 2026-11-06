import {
  SessionEventType,
  traceContextToLogContext,
  type ExecutionPort,
  type SessionEvent,
  type SubagentTaskSnapshot,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import {
  claimRuntimeBackgroundTaskNotification,
  registerRuntimeBackgroundTask,
  releaseRuntimeBackgroundTaskNotification,
  removeRuntimeBackgroundTask,
  updateRuntimeBackgroundTask,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";

type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot;

type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

/**
 * 一个工具的后台生命周期提供者。这五件事若按工具名散在五处 `if (toolCall.name === …)`，
 * 每接一个后台工具就要记得同时改齐五处——漏改一处就是取消入口直接死掉的现场。
 * 按工具名查一次表拿到这个结构，五处分派退化成读它的字段。
 *
 * 缺省语义（字段缺席）与泛化前逐字一致：无 getSnapshot → 无快照提供者（不起 1s 轮询）；
 * 无 waitForTerminal → 无直接等待者；cancellable 缺省 false。
 */
interface BackgroundTaskLifecycleProvider {
  /** 1s 轮询的快照源。 */
  getSnapshot?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 终态直接等待者（比轮询更及时，且轮询源缺席时是唯一终态来源）。 */
  waitForTerminal?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 运行中的任务是否可被用户取消；决定 started/updated payload 的 `cancellable`。 */
  cancellable?: boolean;
}

export class BackgroundTaskTracker {
  private readonly backgroundPollers = new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  async trackBackgroundTask(
    toolCall: ExecutableToolCall,
    output: unknown,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    if (!isRecord(output)) return;
    if (!isBackgroundTaskLaunch(toolCall, output)) return;
    const taskId =
      typeof output.backgroundTaskId === "string"
        ? output.backgroundTaskId
        : typeof output.agentId === "string"
          ? output.agentId
          : undefined;
    if (!taskId || this.backgroundPollers.has(taskId)) return;

    this.backgroundPollers.add(taskId);
    registerRuntimeBackgroundTask(this.deps, toolCall, taskId, output, turnId);
    try {
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskStarted,
        this.backgroundTaskPayload(toolCall, taskId, "running", undefined, output),
        traceContext,
        turnId,
      );
    } catch (error) {
      this.backgroundPollers.delete(taskId);
      removeRuntimeBackgroundTask(this.deps, toolCall, taskId);
      throw error;
    }

    const hasSnapshotProvider = this.hasBackgroundTaskSnapshotProvider(toolCall);
    const hasDirectWaiter = this.hasDirectBackgroundTaskWaiter(toolCall);
    this.deps.logger?.info?.("Background task tracking started", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.started",
      hasDirectWaiter,
      hasSnapshotProvider,
      module: "core.tool.executor",
      taskId,
      toolName: toolCall.name,
    });

    if (!hasSnapshotProvider && !hasDirectWaiter) {
      this.deps.logger?.info?.("Background task tracking lost without snapshot source", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.lost",
        module: "core.tool.executor",
        reason: "missing_snapshot_source",
        taskId,
        toolName: toolCall.name,
      });
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
      this.maybeEnqueueBackgroundTaskNotification(
        toolCall,
        taskId,
        "lost",
        undefined,
        traceContext,
        output,
      );
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskCompleted,
        this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
        traceContext,
        turnId,
      );
      this.backgroundPollers.delete(taskId);
      return;
    }

    let lastSnapshotSignature = "";
    let completing = false;
    let polling = false;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

    const stopTracking = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      maxRuntimeTimer = undefined;
      this.backgroundPollers.delete(taskId);
    };

    if (
      toolCall.name === "Bash" &&
      this.deps.runtimeScope === "subagent" &&
      this.deps.subagentBackgroundBashMaxMs !== undefined &&
      this.deps.executionPort?.cancelBackgroundTask
    ) {
      maxRuntimeTimer = setTimeout(() => {
        this.deps.logger?.warn("Subagent background Bash exceeded max runtime; cancelling", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.subagent_bash.max_runtime_exceeded",
          module: "core.tool.executor",
          taskId,
          toolName: toolCall.name,
        });
        void Promise.resolve(this.deps.executionPort?.cancelBackgroundTask?.(taskId)).catch(
          (error) => {
            this.deps.logger?.warn("Subagent background Bash cancellation failed", {
              ...traceContextToLogContext(traceContext),
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "background_task.subagent_bash.cancel_failed",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            });
          },
        );
      }, this.deps.subagentBackgroundBashMaxMs);
    }

    const emitRunningUpdate = async (snapshot: BackgroundTaskSnapshot) => {
      const signature = this.backgroundSnapshotSignature(snapshot);
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
      await this.emitBackgroundTaskEvent(
        SessionEventType.BackgroundTaskUpdated,
        this.backgroundTaskPayload(toolCall, taskId, "running", snapshot, output),
        traceContext,
        turnId,
      );
    };

    const emitTerminalSnapshot = async (
      snapshot: BackgroundTaskSnapshot | undefined,
    ): Promise<void> => {
      if (stopped || completing) return;
      completing = true;
      try {
        if (!snapshot) {
          this.deps.logger?.info?.("Background task terminal snapshot missing", {
            ...traceContextToLogContext(traceContext),
            event: "background_task.tracking.lost",
            module: "core.tool.executor",
            reason: "snapshot_missing",
            taskId,
            toolName: toolCall.name,
          });
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "lost");
          this.maybeEnqueueBackgroundTaskNotification(
            toolCall,
            taskId,
            "lost",
            undefined,
            traceContext,
            output,
          );
          await this.emitBackgroundTaskEvent(
            SessionEventType.BackgroundTaskCompleted,
            this.backgroundTaskPayload(toolCall, taskId, "lost", undefined, output),
            traceContext,
            turnId,
          );
          stopped = true;
          stopTracking();
          return;
        }

        if (snapshot.status === "running") {
          updateRuntimeBackgroundTask(this.deps, toolCall, taskId, "running", snapshot);
          await emitRunningUpdate(snapshot);
          if (!hasSnapshotProvider) {
            stopped = true;
            stopTracking();
          }
          return;
        }

        if (this.isNotifiedLocalAgentSnapshot(toolCall, snapshot)) {
          this.deps.logger?.debug?.(
            "Background task terminal notification already handled by subagent",
            {
              ...traceContextToLogContext(traceContext),
              event: "background_task.tracking.notification_already_handled",
              module: "core.tool.executor",
              taskId,
              toolName: toolCall.name,
            },
          );
          stopped = true;
          stopTracking();
          return;
        }

        this.deps.logger?.info?.("Background task terminal snapshot observed", {
          ...traceContextToLogContext(traceContext),
          event: "background_task.tracking.terminal",
          module: "core.tool.executor",
          taskId,
          taskStatus: snapshot.status,
          toolName: toolCall.name,
        });
        updateRuntimeBackgroundTask(this.deps, toolCall, taskId, snapshot.status, snapshot);
        this.maybeEnqueueBackgroundTaskNotification(
          toolCall,
          taskId,
          snapshot.status,
          snapshot,
          traceContext,
        );
        await this.emitBackgroundTaskEvent(
          SessionEventType.BackgroundTaskCompleted,
          this.backgroundTaskPayload(toolCall, taskId, snapshot.status, snapshot, output),
          traceContext,
          turnId,
        );
        stopped = true;
        stopTracking();
      } finally {
        completing = false;
      }
    };

    const poll = async () => {
      if (polling || stopped || !hasSnapshotProvider) return;
      polling = true;
      try {
        const snapshot = await this.getBackgroundTaskSnapshot(toolCall, taskId);
        if (!snapshot) {
          await emitTerminalSnapshot(undefined);
          return;
        }

        if (snapshot.status === "running") {
          await emitRunningUpdate(snapshot);
          return;
        }

        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task polling failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
      } finally {
        polling = false;
      }
    };

    const waitForCompletion = async () => {
      try {
        const snapshot = await this.waitForBackgroundTaskSnapshot(toolCall, taskId);
        await emitTerminalSnapshot(snapshot);
      } catch (error) {
        this.deps.logger?.warn("Background task wait failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          module: "core.tool.executor",
          taskId,
        });
        if (!hasSnapshotProvider) {
          stopped = true;
          stopTracking();
        }
      }
    };

    if (hasSnapshotProvider) {
      timer = setInterval(() => {
        void poll();
      }, 1_000);
      timer.unref?.();
      await poll();
    }

    if (hasDirectWaiter && !stopped) {
      void waitForCompletion();
    }
  }

  private async emitBackgroundTaskEvent(
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    traceContext: TraceContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    await this.deps.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: this.deps.sessionId,
      turnId,
      type,
      timestamp: new Date(),
      traceId: traceContext.traceId,
      sequenceNumber: 0,
      payload,
    });
  }

  private backgroundTaskPayload(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot?: BackgroundTaskSnapshot,
    output?: Record<string, unknown>,
  ): Record<string, unknown> {
    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

    return {
      taskId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      // V4 projection 过去从 toolName 手写推断类型，漏掉真实 Agent
      // 工具名后把后台 subagent 投成 bash/process。runtime 在事实产生处一次裁决。
      // 生命周期行为不受影响——那已经由 per-tool 的 lifecycleProvider 分派。
      taskKind: backgroundTaskKind(toolCall.name),
      childSessionId: outputMetadata.childSessionId,
      cancellable: status === "running" && this.canCancelBackgroundTask(toolCall),
      command: typeof input.command === "string" ? input.command : undefined,
      description:
        typeof input.description === "string"
          ? input.description
          : snapshot && "description" in snapshot
            ? snapshot.description
            : undefined,
      status,
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      startedAt: snapshot?.startedAt,
      completedAt: snapshot?.completedAt,
      outputPath: outputMetadata.outputFile,
      stderrPersistedOutputPath: outputMetadata.stderrFile,
      stdoutPersistedOutputPath: outputMetadata.stdoutFile,
      outputBytes: outputMetadata.outputBytes,
      outputTruncated: outputMetadata.outputTruncated,
      outputTail: outputMetadata.outputTail,
      stderrBytes: outputMetadata.stderrBytes,
      stderrTail: outputMetadata.stderrTail,
      stdoutBytes: outputMetadata.stdoutBytes,
      stdoutTail: outputMetadata.stdoutTail,
      terminalId: taskId,
    };
  }

  private backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
    return JSON.stringify({
      pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
      stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
      stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
      stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
      stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
    });
  }

  private canCancelBackgroundTask(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).cancellable === true;
  }

  private isNotifiedLocalAgentSnapshot(
    toolCall: ExecutableToolCall,
    snapshot: BackgroundTaskSnapshot,
  ): boolean {
    const record = snapshot as unknown as Record<string, unknown>;
    return (
      isSubagentDispatchToolName(toolCall.name) &&
      record.type === "local_agent" &&
      record.notified === true
    );
  }

  private maybeEnqueueBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    traceContext: TraceContext,
    output?: Record<string, unknown>,
  ): void {
    if (!this.deps.enqueueBackgroundTaskNotification) {
      this.deps.logger?.debug?.("Background task notification queue unavailable", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.queue_unavailable",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    if (
      this.deps.shouldEnqueueBackgroundTaskNotification?.({
        runtimeScope: this.deps.runtimeScope,
        status,
        taskId,
        toolName: toolCall.name,
        traceContext,
      }) === false
    ) {
      this.deps.logger?.info?.("Background task notification suppressed by runtime policy", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.suppressed",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }

    const text = this.formatBackgroundTaskNotification(toolCall, taskId, status, snapshot, output);
    if (!text) {
      this.deps.logger?.debug?.("Background task notification skipped without formatted message", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.notification.skipped",
        module: "core.tool.executor",
        reason: "empty_message",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    // TaskOutput 读取终态会先把同一 registry task 标成 notified；
    // completion 只有成功 claim 后才能入队，避免模型同时收到 tool result 和重复通知。
    if (!claimRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId)) {
      this.deps.logger?.debug?.("Background task notification already claimed", {
        ...traceContextToLogContext(traceContext),
        event: "background_task.tracking.notification_already_handled",
        module: "core.tool.executor",
        taskId,
        taskStatus: status,
        toolName: toolCall.name,
      });
      return;
    }
    try {
      this.deps.enqueueBackgroundTaskNotification({
        ...(toolCall.name === "Bash"
          ? {
              originMeta: {
                backgroundSource: "bash" as const,
                title: resolveBashBackgroundResultTitle(toolCall, taskId),
                workId: taskId,
              },
            }
          : {}),
        taskId,
        text,
        toolName: toolCall.name,
        traceContext,
      });
    } catch (error) {
      releaseRuntimeBackgroundTaskNotification(this.deps, toolCall, taskId);
      this.deps.logger?.warn("Background task notification enqueue failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        module: "core.tool.executor",
        taskId,
      });
      return;
    }
    this.deps.logger?.info?.("Background task notification enqueued", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.enqueued",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
  }

  private formatBackgroundTaskNotification(
    toolCall: ExecutableToolCall,
    taskId: string,
    status: string,
    snapshot: BackgroundTaskSnapshot | undefined,
    output?: Record<string, unknown>,
  ): string | undefined {
    if (toolCall.name !== "Bash") return undefined;

    const input = isRecord(toolCall.input) ? toolCall.input : {};
    const command = typeof input.command === "string" ? input.command : undefined;
    const description = typeof input.description === "string" ? input.description : undefined;
    const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
    const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
    const notificationStatus = normalizeBashTaskNotificationStatus(status);
    const summary = buildBackgroundTaskSummary({
      command,
      description,
      exitCode: result?.exitCode,
      lost: status === "lost",
      status: notificationStatus,
    });
    return formatTaskNotification({
      description,
      outputFile: outputMetadata.outputFile,
      status: notificationStatus,
      summary,
      taskId,
      taskType: "local_bash",
      toolUseId: toolCall.id,
    });
  }

  private hasBackgroundTaskSnapshotProvider(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).getSnapshot !== undefined;
  }

  private hasDirectBackgroundTaskWaiter(toolCall: ExecutableToolCall): boolean {
    return this.lifecycleProvider(toolCall).waitForTerminal !== undefined;
  }

  private async waitForBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).waitForTerminal?.(taskId);
  }

  private async getBackgroundTaskSnapshot(
    toolCall: ExecutableToolCall,
    taskId: string,
  ): Promise<BackgroundTaskSnapshot | undefined> {
    return this.lifecycleProvider(toolCall).getSnapshot?.(taskId);
  }

  /**
   * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
   * 与泛化前的五处 if 一一对应，语义逐字保持。
   */
  private lifecycleProvider(toolCall: ExecutableToolCall): BackgroundTaskLifecycleProvider {
    const deps = this.deps;

    if (isSubagentDispatchToolName(toolCall.name)) {
      const getTask = deps.subagentPort?.getTask;
      return {
        ...(getTask
          ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
          : {}),
        // background Agent 的停止入口在 subagentPort.stopTask；
        // started payload 不能沿用 Bash 的 executionPort 能力判断。
        cancellable: Boolean(deps.subagentPort?.stopTask),
      };
    }

    if (toolCall.name === "Bash") {
      const waiter = getBackgroundTaskWaiter(deps.executionPort);
      const getBackgroundTask = deps.executionPort?.getBackgroundTask;
      return {
        ...(getBackgroundTask
          ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
          : {}),
        ...(waiter
          ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
          : {}),
        cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
      };
    }

    // 其余工具沿用 executionPort 的通用后台面（无直接等待者），与泛化前一致。
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }
}

function isBackgroundTaskLaunch(
  toolCall: ExecutableToolCall,
  output: Record<string, unknown>,
): boolean {
  if (output.status === "backgrounded") return true;
  return isSubagentDispatchToolName(toolCall.name) && output.status === "async_launched";
}

type BashTaskNotificationStatus = "completed" | "failed" | "killed";

function normalizeBashTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  return normalizeBackgroundTaskNotificationStatus(status);
}

function normalizeBackgroundTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}

function resolveBashBackgroundResultTitle(toolCall: ExecutableToolCall, taskId: string): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Provider-visible summary 保持简洁；完整输出路径由 task-notification 的 output-file 字段承载。
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getBackgroundTaskWaiter(
  executionPort: ExecutionPort | undefined,
): BackgroundTaskWaiter | undefined {
  const candidate = executionPort as Partial<BackgroundTaskWaiter> | undefined;
  return typeof candidate?.waitForBackgroundTask === "function"
    ? (candidate as BackgroundTaskWaiter)
    : undefined;
}

/**
 * 后台任务的展示类别（面板分组与图标）。`taskKind` 只是装饰：生命周期语义已经由
 * per-tool 的 lifecycleProvider 分派，所以这里的分类改动不会影响观察/等待/取消。
 */
function backgroundTaskKind(toolName: string): "bash" | "subagent" {
  return isSubagentDispatchToolName(toolName) ? "subagent" : "bash";
}
