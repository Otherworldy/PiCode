import type { ModelInputMessage, ModelToolCall, ModelToolContract } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import {
  type ProviderRegistryModelSource,
  type RuntimeModelFactory,
} from "../app/provider-registry-model-runtime.js";
import { completeAuxiliaryRegistryModelSelection } from "../app/provider-registry-selection.js";
import type { DelegateModelChunk, ZCodeModelStreamPort } from "@zcode/pi-host";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const rec = asRecord(block);
      if (!rec) return "";
      if (rec.type === "text" && typeof rec.text === "string") return rec.text;
      if (rec.type === "thinking" && typeof rec.thinking === "string") return rec.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toZcodeMessages(messages: unknown[]): ModelInputMessage[] {
  const out: ModelInputMessage[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message || typeof message.role !== "string") continue;
    if (message.role === "system") {
      out.push({ role: "system", content: textOf(message.content) });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: textOf(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const toolCalls: ModelToolCall[] = [];
      for (const block of blocks) {
        const rec = asRecord(block);
        if (rec?.type !== "toolCall" || typeof rec.id !== "string" || typeof rec.name !== "string") {
          continue;
        }
        toolCalls.push({ id: rec.id, name: rec.name, input: rec.arguments ?? {} });
      }
      out.push({
        role: "assistant",
        content: textOf(message.content),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        role: "tool",
        content: textOf(message.content),
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        toolName: typeof message.toolName === "string" ? message.toolName : "",
        isError: message.isError === true,
      });
    }
  }
  return out;
}

function toZcodeTools(tools: unknown[] | undefined): ModelToolContract[] | undefined {
  if (!tools?.length) return undefined;
  const mapped = tools.flatMap((tool) => {
    const rec = asRecord(tool);
    if (!rec || typeof rec.name !== "string") return [];
    const parameters = rec.parameters;
    const inputSchema =
      parameters && typeof parameters === "object"
        ? (JSON.parse(JSON.stringify(parameters)) as ModelToolContract["inputSchema"])
        : { type: "object" };
    return [
      {
        name: rec.name,
        description: typeof rec.description === "string" ? rec.description : undefined,
        inputSchema,
      },
    ];
  });
  return mapped.length > 0 ? mapped : undefined;
}

function asArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { value: input };
    }
  }
  return {};
}

export function createPiZcodeModelStream(options: {
  modelFactory: RuntimeModelFactory;
  registry: ProviderRegistryModelSource;
  defaultSelection?: ModelSelection;
}): ZCodeModelStreamPort["stream"] {
  return async function* (input) {
    const providerId = input.providerId?.trim();
    const modelId = input.modelId?.trim();
    const requested =
      providerId && modelId && providerId !== "zcode"
        ? { providerId, modelId, ...(input.thought ? { options: { reasoningLevel: input.thought } } : {}) }
        : options.defaultSelection;
    if (!requested) {
      yield { type: "error", error: "no zcode model selected" } satisfies DelegateModelChunk;
      yield { type: "done" };
      return;
    }
    const selection = completeAuxiliaryRegistryModelSelection(options.registry, requested);
    let emittedDone = false;
    try {
      const model = options.modelFactory({ selection });
      const pending = new Map<string, { name: string; args: string }>();
      for await (const event of model.streamText({
        messages: toZcodeMessages(input.messages),
        tools: toZcodeTools(input.tools),
        abortSignal: input.signal,
      })) {
        if (event.type === "text_delta" && event.text) {
          yield { type: "text", text: event.text };
        } else if (event.type === "reasoning_delta" && event.text) {
          yield { type: "thinking", text: event.text };
        } else if (event.type === "tool_input_start") {
          pending.set(event.id, { name: event.toolName, args: "" });
        } else if (event.type === "tool_input_delta") {
          const current = pending.get(event.id);
          if (current) current.args += event.delta;
        } else if (event.type === "tool_call") {
          pending.delete(event.toolCall.id);
          yield {
            type: "tool_call",
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: asArgs(event.toolCall.input),
          };
        } else if (event.type === "error") {
          yield {
            type: "error",
            error: event.error instanceof Error ? event.error.message : String(event.error),
          };
        } else if (event.type === "finish") {
          for (const [id, call] of pending) {
            yield { type: "tool_call", id, name: call.name, arguments: asArgs(call.args) };
          }
          pending.clear();
          emittedDone = true;
          yield { type: "done" };
        }
      }
    } catch (error) {
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!emittedDone) yield { type: "done" };
  };
}
