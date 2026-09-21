import type { HostQueue } from "./host-queue.js";
import type { PiSessionPort } from "./types.js";

export type SendDelivery = "startNow" | "queue" | "guide";

export interface AdmitSendInput {
  text: string;
  clientId: string;
  commandId: string;
  delivery: SendDelivery;
  streaming: boolean;
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
  ) {}

  async admitSend(input: AdmitSendInput): Promise<AdmitSendResult> {
    if (input.streaming && input.delivery === "guide") {
      await this.session.steer(input.text);
      return { kind: "steer" };
    }
    if (input.streaming || input.delivery === "queue") {
      const item = this.queue.createItem({
        sourceCommandId: input.commandId,
        clientId: input.clientId,
        text: input.text,
        admitted: "queue",
      });
      this.queue.enqueue(item);
      return { kind: "queued", queueItemId: item.queueItemId };
    }
    const accepted = await this.session.prompt(input.text);
    if (!accepted) throw new Error("pi prompt rejected");
    return { kind: "prompt" };
  }

  async drainNext(): Promise<boolean> {
    if (!this.queue.autoDrain) return false;
    const item = this.queue.shift();
    if (!item) return false;
    const accepted = await this.session.prompt(item.text);
    if (!accepted) throw new Error("pi prompt rejected");
    return true;
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
