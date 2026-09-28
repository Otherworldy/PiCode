import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { HostQueue } from "./host-queue.js";
import { loadPromptImages, promptAttachmentRefs, type PiPromptAttachment } from "./prompt-images.js";
import type { PiSessionPort } from "./types.js";

export type SendDelivery = "startNow" | "queue" | "guide";

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
    if (input.streaming && input.delivery === "guide") {
      await this.useModel(input.modelSelection);
      await this.promptNow("steer", input.text, input.attachments);
      return { kind: "steer" };
    }
    if (input.streaming || input.delivery === "queue") {
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
    const item = this.queue.shift();
    if (!item) return false;
    const selected = item.modelSelection;
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
  }

  private async promptNow(
    kind: "prompt" | "steer",
    text: string,
    attachments: readonly PiPromptAttachment[] | undefined,
  ): Promise<void> {
    const images = await loadPromptImages(attachments);
    const refs = promptAttachmentRefs(attachments);
    if (refs.length > 0) this.noteAttachments?.(refs);
    if (kind === "steer") {
      await this.session.steer(text, images.length > 0 ? images : undefined);
      return;
    }
    const accepted = await this.session.prompt(text, images.length > 0 ? { images } : undefined);
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
