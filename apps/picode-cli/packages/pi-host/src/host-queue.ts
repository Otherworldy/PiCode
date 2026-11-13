import type { AttachmentRef, QueueItem, QueueState } from "@picode/shared/picode-protocol-v4";

export interface QueueConsumerClaim {
  readonly released: Promise<void>;
  release(): void;
}

export class HostQueue {
  private consumer?: QueueConsumerClaim;

  get canAutoDrain(): boolean {
    return this.autoDrain && !this.consumer;
  }

  get consumerReleased(): Promise<void> | undefined {
    return this.consumer?.released;
  }

  ownsConsumer(consumer: QueueConsumerClaim): boolean {
    return this.consumer === consumer;
  }

  tryAcquireConsumer(): QueueConsumerClaim | undefined {
    if (this.consumer) return undefined;
    const settled = Promise.withResolvers<void>();
    const consumer: QueueConsumerClaim = {
      released: settled.promise,
      release: () => {
        if (this.consumer !== consumer) return;
        // 占用和自动消费授权分离，释放不能覆盖用户暂停或 compact 失败产生的 hold。
        this.consumer = undefined;
        settled.resolve();
      },
    };
    this.consumer = consumer;
    return consumer;
  }

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
    attachments?: AttachmentRef[];
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
      attachments: input.attachments ?? [],
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
    const current = this.items.find((item) => item.queueItemId === queueItemId);
    if (!current || current.dispatch.state !== "queued") return null;
    const next = this.items.filter((item) => item.queueItemId !== queueItemId);
    this.items = next;
    return this.snapshot();
  }

  reorder(queueItemId: string, beforeQueueItemId: string | null): QueueState | null {
    const from = this.items.findIndex((item) => item.queueItemId === queueItemId);
    if (from < 0 || this.items[from]?.dispatch.state !== "queued") return null;
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

  /** SDK 撤回成功后保留待生效事实，直到 durable cancelled 确认以便失败时可重试。 */
  markGuideCancellationPending(sourceCommandId: string): QueueItem | undefined {
    const current = this.items.find((item) => item.sourceCommandId === sourceCommandId);
    if (
      !current ||
      current.delivery.admitted !== "guide" ||
      current.dispatch.state !== "reserved" ||
      current.steer.state !== "steering"
    )
      return undefined;
    const next = { ...current, cancelSettlementPending: true };
    this.items = this.items.map((item) => (item === current ? next : item));
    return next;
  }

  /** GUIDE 只由消费、失败或 durable cancelled 确认后的撤回交接收口。 */
  consume(sourceCommandId: string): QueueItem | undefined {
    const item = this.items.find((item) => item.sourceCommandId === sourceCommandId);
    if (item) this.items = this.items.filter((entry) => entry !== item);
    return item;
  }

  markSteering(sourceCommandId: string): void {
    this.items = this.items.map((item) =>
      item.sourceCommandId === sourceCommandId ? { ...item, steer: { state: "steering" } } : item,
    );
  }

  shift(): QueueItem | undefined {
    // SDK 已持有的 GUIDE 只是待消费事实；跳过它唤醒普通 FIFO，其他 reservation 仍是屏障。
    const index = this.items.findIndex(
      (item) => !(item.dispatch.state === "reserved" && item.delivery.admitted === "guide"),
    );
    const first = this.items[index];
    if (first?.dispatch.state !== "queued") return undefined;
    this.items = this.items.filter((_, position) => position !== index);
    return first;
  }

  /** drain 的 prompt 被拒时把刚取走的项放回队首，避免消息丢掉。 */
  unshift(item: QueueItem): void {
    this.items = [item, ...this.items];
  }

  clear(): QueueState {
    this.items = this.items.filter((item) => item.dispatch.state !== "queued");
    return this.snapshot();
  }
}
