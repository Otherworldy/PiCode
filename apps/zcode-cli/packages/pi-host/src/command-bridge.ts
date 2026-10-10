import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { HostQueue } from "./host-queue.js";
import {
  appendFileAttachments,
  loadPromptImages,
  promptAttachmentRefs,
  type PiPromptAttachment,
} from "./prompt-images.js";
import type { PiSessionPort } from "./types.js";

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
  modelSelection?: SubmissionModel;
  attachments?: PiPromptAttachment[];
}

export type AdmitSendResult =
  | { kind: "prompt" }
  | { kind: "steer" }
  | { kind: "followUp" }
  | { kind: "queued"; queueItemId: string };

export class CommandBridge {
  constructor(
    private readonly session: PiSessionPort,
    private readonly queue: HostQueue,
    private readonly applyModel?: (selection: SubmissionModel) => Promise<void>,
    private readonly noteAttachments?: (attachments: AttachmentRef[]) => void,
  ) {}

  async admitSend(input: AdmitSendInput): Promise<AdmitSendResult> {
    // 调用方的 streaming 只看投影 phase。Pi 仍在跑时这里必须自己再判一次，
    // 否则会裸 prompt，Pi 抛 "already processing" 把进程打退出。
    const busy = input.streaming || piSessionBusy(this.session);
    // 压缩中不能 steer，只能排队。guide 只在这一轮真的还在流式输出时生效。
    if (busy && input.delivery === "guide" && this.session.isStreaming) {
      await this.useModel(input.modelSelection);
      await this.promptNow("steer", input.text, input.attachments);
      return { kind: "steer" };
    }
    if (busy || input.delivery === "queue") {
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
    await this.useModel(input.modelSelection);
    await this.promptNow("prompt", input.text, input.attachments);
    return { kind: "prompt" };
  }

  async drainNext(): Promise<boolean> {
    if (!this.queue.autoDrain) return false;
    if (piSessionBusy(this.session)) return false;
    const item = this.queue.shift();
    if (!item) return false;
    const selected = item.modelSelection;
    try {
      await this.useModel(
        selected
          ? {
              providerId: selected.providerId,
              modelId: selected.modelId,
              ...(selected.options?.reasoningLevel ? { thought: selected.options.reasoningLevel } : {}),
            }
          : undefined,
      );
      await this.promptNow("prompt", item.text, item.attachments);
      return true;
    } catch (error) {
      this.queue.unshift(item);
      throw error;
    }
  }

  private async promptNow(
    kind: "prompt" | "steer",
    text: string,
    attachments: readonly PiPromptAttachment[] | undefined,
  ): Promise<void> {
    const body = await appendFileAttachments(text, attachments);
    const images = await loadPromptImages(attachments);
    const refs = promptAttachmentRefs(attachments);
    if (refs.length > 0) this.noteAttachments?.(refs);
    if (kind === "steer") {
      await this.session.steer(body, images.length > 0 ? images : undefined);
      return;
    }
    // 等附件的空档里上一轮可能又开始跑。这时不能再 prompt。
    if (piSessionBusy(this.session)) {
      throw new Error("pi prompt rejected: already streaming");
    }
    const accepted = await this.session.prompt(body, images.length > 0 ? { images } : undefined);
    if (!accepted) {
      if (refs.length > 0) this.noteAttachments?.([]);
      throw new Error("pi prompt rejected");
    }
  }

  private async useModel(selection: SubmissionModel | undefined): Promise<void> {
    if (!selection?.providerId || !selection.modelId || !this.applyModel) return;
    await this.applyModel(selection);
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
