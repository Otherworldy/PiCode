import { AsyncLocalStorage } from "node:async_hooks";
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
