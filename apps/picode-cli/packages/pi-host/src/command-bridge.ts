import type { AttachmentRef } from "@picode/shared/picode-protocol-v4";
import type { HostQueue, QueueConsumerClaim } from "./host-queue.js";
import {
  appendFileAttachments,
  loadPromptImages,
  promptAttachmentRefs,
  type PiPromptAttachment,
} from "./prompt-images.js";
import { registeredExtensionCommandText } from "./pi-slash-commands.js";
import { ensurePlannotatorToolActive } from "./tool-loadout.js";
import type { PiInputIdentity, PiSessionPort } from "./types.js";

export type SendDelivery = "startNow" | "queue" | "guide";

/** 画面还在跑、或 Pi 正在压缩，都先入队。guide 只在这一轮真正在跑时 steer。 */
export function sendDelivery(input: {
  guide: boolean;
  phaseRunning: boolean;
  idle: boolean;
}): SendDelivery {
  if (input.guide && input.phaseRunning) return "guide";
  if (input.phaseRunning || !input.idle) return "queue";
  return "startNow";
}

/** Pi 自己还在跑。投影 phase 没跟上时也算忙，否则裸 prompt 会把进程打退出。 */
export function piSessionBusy(session: {
  isStreaming: boolean;
  isCompacting?: boolean;
  isIdle?: boolean;
}): boolean {
  return session.isStreaming || session.isCompacting === true || session.isIdle === false;
}

/**
 * 常驻池能不能卸掉这个会话。
 * 只看投影 phase 会把还在 streaming / 压缩 / 后台任务里的会话当空闲，
 * 拆掉后再点开只能冷恢复，界面停在「正在加载会话」。
 */
export function piHostBlocksResidency(input: {
  pi: { isStreaming: boolean; isCompacting?: boolean; isIdle?: boolean };
  phase?: string;
  activeWorkCount?: number;
  queuedCount?: number;
  branchSummary?: boolean;
  backgroundActive?: boolean;
  pendingInteraction?: boolean;
  runningSubagents?: number;
}): boolean {
  return (
    piSessionBusy(input.pi) ||
    input.branchSummary === true ||
    input.phase === "running" ||
    input.phase === "prewarming" ||
    (input.activeWorkCount ?? 0) > 0 ||
    (input.queuedCount ?? 0) > 0 ||
    input.backgroundActive === true ||
    input.pendingInteraction === true ||
    (input.runningSubagents ?? 0) > 0
  );
}

function queuedSelection(selection: SubmissionModel | undefined) {
  if (!selection?.providerId || !selection.modelId) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.thought ? { options: { reasoningLevel: selection.thought } } : {}),
  };
}

export interface SubmissionModel {
  providerId: string;
  modelId: string;
  thought?: string;
}

export interface AdmitSendInput {
  text: string;
  clientId: string;
  commandId: string;
  delivery: SendDelivery;
  streaming: boolean;
  requireIdle?: boolean;
  consumer?: QueueConsumerClaim;
  modelSelection?: SubmissionModel;
  attachments?: PiPromptAttachment[];
}

export type AdmitSendResult =
  | { kind: "prompt" }
  | { kind: "steer" }
  | { kind: "followUp" }
  | { kind: "handled" }
  | { kind: "queued"; queueItemId: string };

/** 扩展命令执行期间收 notify。会话忙时也走这里，不进用户队列。 */
export interface ExtensionCommandRunner {
  uiReady?: Promise<unknown>;
  run(command: string, execute: () => Promise<void>): Promise<void>;
}

/**
 * 计划模式开关只是切输入框上已有的一个状态。它的 info 回执再弹一个模态框是噪音，
 * 所以不聚进扩展命令弹窗。warning / error 照旧弹，不吞插件报的问题。
 */
export function suppressesExtensionNotice(command: string, notifyType: string): boolean {
  if (notifyType !== "info") return false;
  return command.trim().replace(/^\/+/, "").toLowerCase() === "plannotator-plan-mode";
}

export class CommandBridge {
  constructor(
    private readonly session: PiSessionPort,
    private readonly queue: HostQueue,
    private readonly applyModel?: (selection: SubmissionModel) => Promise<boolean | void>,
    private readonly noteAttachments?: (attachments: AttachmentRef[]) => void,
    private readonly extensionCommands?: ExtensionCommandRunner,
  ) {}

  async admitSend(input: AdmitSendInput): Promise<AdmitSendResult> {
    if (this.session.toolLoadout) ensurePlannotatorToolActive(this.session.toolLoadout);
    if (input.consumer && !this.queue.ownsConsumer(input.consumer)) throw this.consumerBusy();
    const extensionText = registeredExtensionCommandText(
      input.text,
      this.session.listSlashCommands?.(),
    );
    // 扩展问答通过另一条 RPC 回答，保留流式期间也能非阻塞执行的命令路径。
    if (extensionText && !input.requireIdle) return this.runExtension(input, extensionText, true);
    const consumer = input.consumer ?? this.queue.tryAcquireConsumer();
    if (!consumer) {
      if (input.requireIdle) throw this.consumerBusy();
      // Registry 正在读取模型/附件时 Pi 可能仍 idle；新输入只能排队，不能超车或 steer。
      return this.enqueue(input);
    }
    try {
      const busy = input.streaming || piSessionBusy(this.session);
      if (input.requireIdle && busy) throw this.consumerBusy();
      if (extensionText) return await this.runExtension(input, extensionText, false);
      if (!input.requireIdle && busy && input.delivery === "guide" && this.session.isStreaming) {
        // GUIDE 已交付后仍由 HostQueue 持有可见事实；reserved 阻止普通 drain 重复投递。
        const item = this.queue.createItem({
          sourceCommandId: input.commandId,
          clientId: input.clientId,
          text: input.text,
          admitted: "guide",
          modelSelection: queuedSelection(input.modelSelection),
          attachments: promptAttachmentRefs(input.attachments),
        });
        this.queue.enqueue({
          ...item,
          dispatch: { state: "reserved" },
          steer: { state: "submitting" },
        });
        try {
          await this.useModel(input.modelSelection);
          const kind = await this.promptNow(
            "steer",
            input.text,
            input.attachments,
            false,
            undefined,
            {
              sourceCommandId: input.commandId,
              clientId: input.clientId,
            },
          );
          if (kind === "handled") this.queue.consume(input.commandId);
          else this.queue.markSteering(input.commandId);
          return { kind };
        } catch (error) {
          this.queue.consume(input.commandId);
          throw error;
        }
      }
      if (!input.requireIdle && (busy || input.delivery === "queue")) return this.enqueue(input);
      await this.useModel(input.modelSelection);
      const kind = await this.promptNow("prompt", input.text, input.attachments, false, undefined, {
        sourceCommandId: input.commandId,
        clientId: input.clientId,
      });
      return { kind };
    } finally {
      if (!input.consumer) consumer.release();
    }
  }

  private enqueue(input: AdmitSendInput): AdmitSendResult {
    const item = this.queue.createItem({
      sourceCommandId: input.commandId,
      clientId: input.clientId,
      text: input.text,
      admitted: "queue",
      modelSelection: queuedSelection(input.modelSelection),
      attachments: promptAttachmentRefs(input.attachments),
    });
    this.queue.enqueue(item);
    return { kind: "queued", queueItemId: item.queueItemId };
  }

  private consumerBusy(): Error {
    return Object.assign(new Error("Pi queue consumer requires an idle admission"), {
      reasonCode: "guard.queuePromotionBusy",
    });
  }

  private async runExtension(
    input: AdmitSendInput,
    text: string,
    allowBusy: boolean,
  ): Promise<AdmitSendResult> {
    await this.extensionCommands?.uiReady;
    if (!allowBusy && piSessionBusy(this.session)) throw this.consumerBusy();
    const command = /^\/([^\s]+)/.exec(text)?.[1] ?? "";
    const admitted = allowBusy ? undefined : Promise.withResolvers<void>();
    const execute = () =>
      this.promptNow("prompt", text, input.attachments, allowBusy, admitted?.resolve).then(
        () => undefined,
      );
    const pending = this.extensionCommands
      ? this.extensionCommands.run(command, execute)
      : execute();
    // idle-only 扩展先完成附件准备及最终 busy 检查；调用 Pi 后即返回，问卷仍由另一条 RPC 继续。
    void pending.catch((error: unknown) => admitted?.reject(error));
    await admitted?.promise;
    return { kind: "handled" };
  }

  async drainNext(): Promise<boolean> {
    if (!this.queue.canAutoDrain || piSessionBusy(this.session)) return false;
    const consumer = this.queue.tryAcquireConsumer();
    if (!consumer) return false;
    try {
      const item = this.queue.shift();
      if (!item) return false;
      const selected = item.modelSelection;
      try {
        await this.useModel(
          selected
            ? {
                providerId: selected.providerId,
                modelId: selected.modelId,
                ...(selected.options?.reasoningLevel
                  ? { thought: selected.options.reasoningLevel }
                  : {}),
              }
            : undefined,
        );
        await this.promptNow("prompt", item.text, item.attachments, false, undefined, {
          sourceCommandId: item.sourceCommandId,
          clientId: item.clientId,
        });
        return true;
      } catch (error) {
        this.queue.unshift(item);
        throw error;
      }
    } finally {
      consumer.release();
    }
  }

  private async promptNow(
    kind: "prompt" | "steer",
    text: string,
    attachments: readonly PiPromptAttachment[] | undefined,
    allowBusy = false,
    onPromptInvoked?: () => void,
    identity?: PiInputIdentity,
  ): Promise<"prompt" | "steer" | "handled"> {
    const body = await appendFileAttachments(text, attachments);
    const images = await loadPromptImages(attachments);
    const refs = promptAttachmentRefs(attachments);
    const options = {
      ...(images.length > 0 ? { images } : {}),
      ...(identity ? { picodeInput: { ...identity, attachments: refs } } : {}),
      ...(kind === "steer" ? { streamingBehavior: "steer" as const } : {}),
    };
    // 附件和 SDK input handler 都可能跨过原轮次结束，最终忙闲交给 SDK prompt 判断。
    // 已交给 SDK 的 GUIDE 不能在空闲时再次裸 steer，否则只入队却不会唤起运行。
    if (kind !== "steer" && !allowBusy && piSessionBusy(this.session)) {
      throw Object.assign(new Error("pi prompt rejected: already streaming"), {
        reasonCode: "guard.queuePromotionBusy",
      });
    }
    if (refs.length > 0 && !identity) this.noteAttachments?.(refs);
    const pending = this.session.prompt(body, Object.keys(options).length ? options : undefined);
    onPromptInvoked?.();
    const accepted = await pending;
    if (accepted === "handled") return "handled";
    if (accepted === "queued") return "steer";
    if (!accepted) {
      if (refs.length > 0) this.noteAttachments?.([]);
      throw new Error("pi prompt rejected");
    }
    return "prompt";
  }

  private async useModel(selection: SubmissionModel | undefined): Promise<void> {
    if (!selection?.providerId || !selection.modelId || !this.applyModel) return;
    // admission 不因目录抖动阻断发送：失败只告警，下一次提交会重新携带选择。
    const applied = await this.applyModel(selection);
    if (applied === false) {
      console.warn("pi-host submission model not applied", {
        providerId: selection.providerId,
        modelId: selection.modelId,
      });
    }
  }

  async stop(): Promise<void> {
    await this.session.abort();
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  syncFollowupMode(mode: "queue" | "guide"): void {
    this.queue.followupMode = mode;
    this.session.setSteeringMode?.(mode === "guide" ? "all" : "one-at-a-time");
    this.session.setFollowUpMode?.(mode === "queue" ? "one-at-a-time" : "all");
  }
}
