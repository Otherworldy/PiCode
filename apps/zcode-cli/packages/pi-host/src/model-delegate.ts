import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type JsonObject,
  type Model,
  type Provider,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { PiThinkingLevel } from "./types.js";

export type DelegateModelChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "error"; error: string }
  | { type: "done" };

export interface ZCodeModelStreamPort {
  stream(input: {
    messages: unknown[];
    tools?: unknown[];
    signal?: AbortSignal;
    sessionId?: string;
    providerId?: string;
    modelId?: string;
    thought?: string;
  }): AsyncIterable<DelegateModelChunk>;
}

export interface DelegateProvider {
  provider: Provider;
  model: Model<string>;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const THOUGHT: Record<string, PiThinkingLevel> = {
  off: "off",
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function mapThought(thought: string | undefined): PiThinkingLevel {
  if (!thought) return "off";
  return THOUGHT[thought.trim().toLowerCase()] ?? "off";
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function collectTools(messages: TranscriptContext["messages"]): unknown[] {
  const tools = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

function runDelegateStream(
  model: Model<string>,
  context: TranscriptContext,
  options: { signal?: AbortSignal; sessionId?: string } | undefined,
  streamFn: ZCodeModelStreamPort["stream"],
) {
  const events = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: "pending",
    timestamp: Date.now(),
  };

  const fail = (reason: "aborted" | "error", errorMessage: string) => {
    const error: AssistantMessage = {
      ...partial,
      stopReason: reason,
      errorMessage,
      timestamp: Date.now(),
    };
    events.push({ type: "error", reason, error });
    events.end(error);
  };

  void (async () => {
    try {
      events.push({ type: "start", partial });
      let contentIndex = -1;
      let current: "text" | "thinking" | undefined;
      let stopReason: "stop" | "toolUse" = "stop";

      const closeOpen = () => {
        if (current === "text") {
          const block = partial.content[contentIndex];
          events.push({
            type: "text_end",
            contentIndex,
            content: block?.type === "text" ? block.text : "",
            partial,
          });
        } else if (current === "thinking") {
          const block = partial.content[contentIndex];
          events.push({
            type: "thinking_end",
            contentIndex,
            content: block?.type === "thinking" ? block.thinking : "",
            partial,
          });
        }
        current = undefined;
      };

      for await (const chunk of streamFn({
        messages: context.messages,
        tools: collectTools(context.messages),
        signal: options?.signal,
        sessionId: options?.sessionId,
        providerId: model.provider,
        modelId: model.id,
      })) {
        if (options?.signal?.aborted) {
          fail("aborted", "Request was aborted");
          return;
        }
        if (chunk.type === "done") break;
        if (chunk.type === "error") {
          fail("error", chunk.error);
          return;
        }
        if (chunk.type === "text") {
          if (current !== "text") {
            closeOpen();
            contentIndex += 1;
            partial.content = [...partial.content, { type: "text", text: "" }];
            events.push({ type: "text_start", contentIndex, partial });
            current = "text";
          }
          const block = partial.content[contentIndex];
          if (block?.type === "text") block.text += chunk.text;
          events.push({ type: "text_delta", contentIndex, delta: chunk.text, partial });
          continue;
        }
        if (chunk.type === "thinking") {
          if (current !== "thinking") {
            closeOpen();
            contentIndex += 1;
            partial.content = [...partial.content, { type: "thinking", thinking: "" }];
            events.push({ type: "thinking_start", contentIndex, partial });
            current = "thinking";
          }
          const block = partial.content[contentIndex];
          if (block?.type === "thinking") block.thinking += chunk.text;
          events.push({ type: "thinking_delta", contentIndex, delta: chunk.text, partial });
          continue;
        }
        closeOpen();
        contentIndex += 1;
        stopReason = "toolUse";
        const toolCall = {
          type: "toolCall" as const,
          id: chunk.id,
          name: chunk.name,
          arguments: chunk.arguments as JsonObject,
        };
        partial.content = [...partial.content, { ...toolCall, arguments: {} }];
        events.push({ type: "toolcall_start", contentIndex, partial });
        partial.content[contentIndex] = toolCall;
        events.push({ type: "toolcall_end", contentIndex, toolCall, partial });
      }

      closeOpen();
      const message: AssistantMessage = {
        ...partial,
        stopReason,
        timestamp: Date.now(),
      };
      events.push({ type: "done", reason: stopReason, message });
      events.end(message);
    } catch (error) {
      if (isAbort(error) || options?.signal?.aborted) {
        fail("aborted", "Request was aborted");
        return;
      }
      fail("error", error instanceof Error ? error.message : String(error));
    }
  })();

  return events;
}

export function createDelegateProvider(input: {
  provider?: string;
  modelId?: string;
  stream: ZCodeModelStreamPort["stream"];
  contextWindow?: number;
}): DelegateProvider {
  const providerId = input.provider ?? "zcode";
  const modelId = input.modelId ?? "default";
  const model: Model<string> = {
    id: modelId,
    name: modelId,
    api: "zcode-delegate",
    provider: providerId,
    baseUrl: "http://127.0.0.1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow ?? 200_000,
    maxTokens: 16_384,
  };
  const stream = (
    requestModel: Model<string>,
    context: TranscriptContext,
    options?: { signal?: AbortSignal },
  ) => runDelegateStream(requestModel, context, options, input.stream);
  const provider = createProvider({
    id: providerId,
    name: "ZCode",
    auth: {
      apiKey: {
        name: "ZCode",
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    api: { stream, streamSimple: stream },
  });
  return { provider, model };
}

/** @deprecated Use createDelegateProvider. Kept so existing callers compile. */
export function createDelegateModel(input: {
  provider?: string;
  modelId?: string;
  stream: ZCodeModelStreamPort["stream"];
  contextWindow?: number;
}): Model<string> {
  return createDelegateProvider(input).model;
}
