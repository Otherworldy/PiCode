import type { TraceContext, TurnState } from "./deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import type {
  ActiveTurnStartReservation,
  ContinueActiveTargetLoopOptions,
  ExecuteTurnOptions,
  TurnResult,
} from "./types.js";

export type RuntimeCommandPriority = "now" | "next" | "later";
export type RuntimeCommandMode =
  | "prompt"
  | "target-continuation"
  | "target-continuation-loop"
  | "task-notification"
  | "subagent-message";
export type RuntimeCommandId = string & {
  readonly __runtimeCommandId: unique symbol;
};

export interface RuntimeCommandBase {
  readonly createdAt: Date;
  readonly id: RuntimeCommandId;
  readonly mode: RuntimeCommandMode;
  readonly priority: RuntimeCommandPriority;
  readonly traceContext: TraceContext;
}

export interface PromptRuntimeCommand extends RuntimeCommandBase {
  readonly attachments?: TurnState["attachments"];
  readonly input: string;
  readonly mode: "prompt";
  readonly options?: ExecuteTurnOptions;
  /** admission 已建立的 reservation；执行阶段不得再次创建/竞争 turn。 */
  readonly startReservation?: ActiveTurnStartReservation;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult) => void;
}

export interface TargetContinuationRuntimeCommandOptions {
  readonly abortSignal?: AbortSignal;
  readonly inputId?: string;
  readonly intent?: ExecuteTurnOptions["intent"];
  readonly traceContext: TraceContext;
  readonly verifyBeforeContinue?: boolean;
}

export interface TargetContinuationRuntimeCommand extends RuntimeCommandBase {
  readonly mode: "target-continuation";
  readonly options: TargetContinuationRuntimeCommandOptions;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult | null) => void;
}

export interface TargetContinuationLoopRuntimeCommand extends RuntimeCommandBase {
  readonly mode: "target-continuation-loop";
  readonly options: ContinueActiveTargetLoopOptions & {
    readonly traceContext: TraceContext;
  };
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: TurnResult | null) => void;
}

export interface TaskNotificationRuntimeCommand extends RuntimeCommandBase {
  readonly branchGeneration: number;
  readonly mode: "task-notification";
  readonly source: "background_task";
  readonly originMeta?: BackgroundResultOriginMeta;
  readonly taskId?: string;
  readonly text: string;
  readonly toolName?: string;
}

export interface SubagentMessageRuntimeCommand extends RuntimeCommandBase {
  readonly branchGeneration: number;
  readonly mode: "subagent-message";
  readonly source: "subagent_message";
  readonly responseId: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly childSessionId: string;
  readonly childToolCallId: string;
  readonly parentToolCallId?: string;
  readonly summary: string;
  readonly messageLength: number;
  readonly text: string;
}

export type RuntimeCommand =
  | PromptRuntimeCommand
  | TargetContinuationRuntimeCommand
  | TargetContinuationLoopRuntimeCommand
  | TaskNotificationRuntimeCommand
  | SubagentMessageRuntimeCommand;

export interface RuntimeCommandQueue {
  clearCancelPending(id: RuntimeCommandId): void;
  consumeCancelPending(id: RuntimeCommandId): boolean;
  dequeue(): RuntimeCommand | undefined;
  dequeueNextBatch(): readonly RuntimeCommand[];
  enqueue(command: RuntimeCommand): void;
  getByMaxPriority(maxPriority: RuntimeCommandPriority): readonly RuntimeCommand[];
  hasPending(): boolean;
  markCancelPending(id: RuntimeCommandId): void;
  removeById(id: RuntimeCommandId): RuntimeCommand | undefined;
  size(): number;
  snapshot(): readonly RuntimeCommand[];
}

const RUNTIME_COMMAND_PRIORITY_ORDER: Record<RuntimeCommandPriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

let runtimeCommandIdSequence = 0;

export function createRuntimeCommandId(): RuntimeCommandId {
  runtimeCommandIdSequence += 1;
  return `runtime_command_${runtimeCommandIdSequence}` as RuntimeCommandId;
}

export function createRuntimeCommandQueue(): RuntimeCommandQueue {
  const commands: RuntimeCommand[] = [];
  const cancelPendingCommandIds = new Set<RuntimeCommandId>();

  const selectNextIndex = (maxPriority?: RuntimeCommandPriority): number => {
    let selectedIndex = -1;
    let selectedPriority = Number.POSITIVE_INFINITY;
    const maxPriorityRank =
      maxPriority === undefined
        ? Number.POSITIVE_INFINITY
        : RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority];

    for (const [index, command] of commands.entries()) {
      const priority = RUNTIME_COMMAND_PRIORITY_ORDER[command.priority];
      if (priority > maxPriorityRank) continue;
      if (priority < selectedPriority) {
        selectedIndex = index;
        selectedPriority = priority;
      }
    }

    return selectedIndex;
  };

  return {
    clearCancelPending(id: RuntimeCommandId): void {
      cancelPendingCommandIds.delete(id);
    },

    consumeCancelPending(id: RuntimeCommandId): boolean {
      return cancelPendingCommandIds.delete(id);
    },

    dequeue(): RuntimeCommand | undefined {
      const index = selectNextIndex();
      if (index === -1) return undefined;
      const [command] = commands.splice(index, 1);
      return command;
    },

    dequeueNextBatch(): readonly RuntimeCommand[] {
      const index = selectNextIndex();
      if (index === -1) return Object.freeze([]);
      const selected = commands[index];
      if (selected?.mode !== "task-notification") {
        const [command] = commands.splice(index, 1);
        return Object.freeze(command ? [command] : []);
      }

      const batch = commands.filter(
        (command) => command.mode === "task-notification" && command.priority === selected.priority,
      );
      for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
        const command = commands[commandIndex];
        if (command?.mode === "task-notification" && command.priority === selected.priority) {
          commands.splice(commandIndex, 1);
        }
      }
      return Object.freeze(batch);
    },

    enqueue(command: RuntimeCommand): void {
      commands.push(command);
    },

    getByMaxPriority(maxPriority: RuntimeCommandPriority): readonly RuntimeCommand[] {
      const maxPriorityRank = RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority];
      return Object.freeze(
        commands.filter(
          (command) => RUNTIME_COMMAND_PRIORITY_ORDER[command.priority] <= maxPriorityRank,
        ),
      );
    },

    hasPending(): boolean {
      return commands.length > 0;
    },

    markCancelPending(id: RuntimeCommandId): void {
      cancelPendingCommandIds.add(id);
    },

    removeById(id: RuntimeCommandId): RuntimeCommand | undefined {
      const index = commands.findIndex((command) => command.id === id);
      if (index === -1) return undefined;
      const [command] = commands.splice(index, 1);
      return command;
    },

    size(): number {
      return commands.length;
    },

    snapshot(): readonly RuntimeCommand[] {
      return Object.freeze([...commands]);
    },
  };
}
