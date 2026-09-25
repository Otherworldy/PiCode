import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

export class HostQueue {
  private items: QueueItem[] = [];
  autoDrain = true;
  followupMode: "queue" | "guide" = "queue";
  private seq = 0;

  snapshot(): QueueState {
    return { items: this.items, autoDrain: this.autoDrain };
  }

  enqueue(item: QueueItem): QueueState {
    this.items = [...this.items, item];
    return this.snapshot();
  }

  createItem(input: {
    sourceCommandId: string;
    clientId: string;
    text: string;
    admitted: "queue" | "guide";
    modelSelection?: QueueItem["modelSelection"];
  }): QueueItem {
    this.seq += 1;
    const queueItemId = input.sourceCommandId;
    return {
      sourceCommandId: input.sourceCommandId,
      queueItemId,
      clientId: input.clientId,
      kind: "sendText",
      text: input.text,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      attachments: [],
      delivery: {
        requested: input.admitted,
        admitted: input.admitted,
      },
      order: { admissionSeq: this.seq, queuePosition: this.items.length },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: Date.now(),
    };
  }

  edit(queueItemId: string, newText: string): QueueState | null {
    const index = this.items.findIndex((item) => item.queueItemId === queueItemId);
    const current = this.items[index];
    if (!current || current.dispatch.state !== "queued") return null;
    const next = [...this.items];
    next[index] = { ...current, text: newText };
    this.items = next;
    return this.snapshot();
  }

  remove(queueItemId: string): QueueState | null {
    const next = this.items.filter((item) => item.queueItemId !== queueItemId);
    if (next.length === this.items.length) return null;
    this.items = next;
    return this.snapshot();
  }

  reorder(queueItemId: string, beforeQueueItemId: string | null): QueueState | null {
    const from = this.items.findIndex((item) => item.queueItemId === queueItemId);
    if (from < 0) return null;
    const copy = [...this.items];
    const [moved] = copy.splice(from, 1);
    if (!moved) return null;
    if (beforeQueueItemId === null) copy.push(moved);
    else {
      const to = copy.findIndex((item) => item.queueItemId === beforeQueueItemId);
      if (to < 0) return null;
      copy.splice(to, 0, moved);
    }
    this.items = copy;
    return this.snapshot();
  }

  shift(): QueueItem | undefined {
    const [first, ...rest] = this.items;
    this.items = rest;
    return first;
  }

  clear(): QueueState {
    this.items = [];
    return this.snapshot();
  }
}
