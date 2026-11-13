import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import { attachmentRefSchema } from "@picode/shared/picode-protocol-v4";
import type { PiInputIdentity } from "./types.js";

/** 原文可被扩展改写；身份绑定实际消息对象，并在最终持久化前恢复。 */
export function bindPiInputIdentity(
  session: Pick<AgentSession, "agent" | "prompt" | "steer" | "followUp">,
) {
  type Submission = {
    input?: PiInputIdentity;
    attached: boolean;
    completion: ReturnType<typeof Promise.withResolvers<void>>;
  };
  const scope = new AsyncLocalStorage<{ submission: Submission; preflight: boolean } | undefined>();
  const submissions = new WeakMap<PromptOptions, Submission>();
  const identities = new WeakMap<object, PiInputIdentity>();
  const tag = (message: { role: string }) => {
    const active = scope.getStore()?.submission;
    if (!active?.input || active.attached || message.role !== "user") return;
    identities.set(message, active.input);
    Object.assign(message, { picodeInput: active.input });
    active.attached = true;
  };
  const agentPrompt = session.agent.prompt.bind(session.agent);
  session.agent.prompt = ((message, images) => {
    if (Array.isArray(message)) message.forEach(tag);
    else if (typeof message !== "string") tag(message);
    return typeof message === "string" ? agentPrompt(message, images) : agentPrompt(message);
  }) as typeof session.agent.prompt;
  const agentSteer = session.agent.steer.bind(session.agent);
  session.agent.steer = (message) => {
    tag(message);
    agentSteer(message);
  };
  const agentFollowUp = session.agent.followUp.bind(session.agent);
  session.agent.followUp = (message) => {
    tag(message);
    agentFollowUp(message);
  };
  const prompt = session.prompt.bind(session);
  const steer = session.steer.bind(session);
  const followUp = session.followUp.bind(session);
  const invoke = (text: string, options?: PromptOptions) => {
    const submission = options && submissions.get(options);
    const invocation = submission ? { submission, preflight: false } : undefined;
    const pending = scope.run(invocation, () => prompt(text, options));
    if (submission) {
      void pending.then(() => {
        // SDK 在 settled 中提前返回并保留同一 options 重入；只有真正经过 preflight 的调用才能完成。
        if (invocation?.preflight) submission.completion.resolve();
      }, submission.completion.reject);
    }
    return pending;
  };
  // 精确识别 Host 的 options 对象以保留 SDK 自身重入；扩展自产输入不继承 ALS。
  session.prompt = invoke;
  session.steer = (...args) => scope.run(undefined, () => steer(...args));
  session.followUp = (...args) => scope.run(undefined, () => followUp(...args));
  return {
    cancelSteering(input: Pick<PiInputIdentity, "sourceCommandId" | "clientId">): boolean {
      // Pi 1.5.0 只有清空整个队列的公开 API；只在此兼容边界同步撤回仍未被 drain 的实际对象。
      const sdk = session as unknown as {
        agent?: { steeringQueue?: { messages?: AgentMessage[] } };
        _steeringMessages?: string[];
        _emitQueueUpdate?: () => void;
      };
      const messages = sdk.agent?.steeringQueue?.messages;
      const texts = sdk._steeringMessages;
      if (
        !Array.isArray(messages) ||
        !Array.isArray(texts) ||
        typeof sdk._emitQueueUpdate !== "function"
      ) {
        throw Object.assign(new Error("Pi SDK steering cancellation is unavailable"), {
          reasonCode: "fault.command.guideCancellationUnavailable",
        });
      }
      const index = messages.findIndex((message) => {
        const identity = identities.get(message);
        return (
          identity?.sourceCommandId === input.sourceCommandId &&
          identity.clientId === input.clientId
        );
      });
      const message = messages[index];
      // SDK 已取走但 message_start 尚未发布时，也必须由消费获胜。
      if (!message || message.role !== "user") return false;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      const textIndex = texts.indexOf(text);
      messages.splice(index, 1);
      // 身份已由实际对象确定；展示镜像可能已被同文输入的 message_start 消耗，只在命中时同步。
      if (textIndex >= 0) texts.splice(textIndex, 1);
      try {
        sdk._emitQueueUpdate();
      } catch {
        // 队列撤回已完成；observer 异常不能让 HostQueue 留下无法重试的幽灵 GUIDE。
      }
      return true;
    },
    prompt(text: string, options: PromptOptions, input?: PiInputIdentity) {
      const submission: Submission = {
        input,
        attached: false,
        completion: Promise.withResolvers<void>(),
      };
      const sdkOptions: PromptOptions = {
        ...options,
        preflightResult(result) {
          const invocation = scope.getStore();
          if (invocation?.submission === submission) invocation.preflight = true;
          options.preflightResult?.(result);
        },
      };
      submissions.set(sdkOptions, submission);
      void invoke(text, sdkOptions);
      return submission.completion.promise;
    },
    restore(message: object): void {
      // message_end 替换会删除自定义字段；WeakMap 跟随原消息对象，写盘前恢复权威身份。
      const input = identities.get(message);
      if (input) Object.assign(message, { picodeInput: input });
    },
  };
}

export function readPiInputIdentity(value: unknown): PiInputIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.sourceCommandId !== "string" || !input.sourceCommandId) return undefined;
  if (typeof input.clientId !== "string" || !input.clientId) return undefined;
  const attachments = attachmentRefSchema.array().safeParse(input.attachments);
  return {
    sourceCommandId: input.sourceCommandId,
    clientId: input.clientId,
    ...(attachments.success ? { attachments: attachments.data } : {}),
  };
}
