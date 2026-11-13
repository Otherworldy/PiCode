import { sendDelivery, type HostedSession, type QueueConsumerClaim } from "@picode/pi-host";
import type { ModelSelection } from "@picode/contracts";
import type { TurnAttachment } from "@picode/core";

export type HostedInputAdmission =
  | { kind: "started_turn"; completion: Promise<void> }
  | { kind: "handled" }
  | { kind: "queued"; pendingInputId: string; queueLength: number };

/** 准入回执只描述真实交付；执行收尾等待 Pi 的当前轮，不制造 Core TurnResult。 */
export async function sendHostedInput(
  hosted: HostedSession,
  input: {
    text: string;
    inputId: string;
    clientId?: string;
    delivery?: "startNow" | "queue" | "guide";
    attachments?: TurnAttachment[];
    modelSelection?: ModelSelection;
    requireIdle?: boolean;
    consumer?: QueueConsumerClaim;
  },
): Promise<HostedInputAdmission> {
  const phaseRunning = hosted.projector.getSnapshot().control.phase === "running";
  if (input.requireIdle && (phaseRunning || !hosted.isIdle)) {
    // 提升失败必须保留原项；不能把同一个 sourceCommandId 再追加进队列。
    throw Object.assign(new Error("Pi queue promotion requires an idle session"), {
      reasonCode: "guard.queuePromotionBusy",
    });
  }
  const result = await hosted.bridge.admitSend({
    text: input.text,
    commandId: input.inputId,
    clientId: input.clientId ?? "v4",
    delivery: input.delivery ?? sendDelivery({ guide: false, phaseRunning, idle: hosted.isIdle }),
    streaming: phaseRunning || !hosted.isIdle,
    requireIdle: input.requireIdle,
    consumer: input.consumer,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.modelSelection
      ? {
          modelSelection: {
            providerId: input.modelSelection.providerId,
            modelId: input.modelSelection.modelId,
            thought: input.modelSelection.options?.reasoningLevel,
          },
        }
      : {}),
  });
  hosted.projector.replaceQueue(hosted.queue.snapshot());
  if (result.kind === "handled") return result;
  if (result.kind === "queued" || result.kind === "steer")
    return {
      kind: "queued",
      pendingInputId: result.kind === "queued" ? result.queueItemId : input.inputId,
      queueLength: hosted.queue.snapshot().items.length,
    };
  return { kind: "started_turn", completion: hosted.waitTurn() };
}

export function isHostedExtensionCommand(hosted: HostedSession | undefined, text: string): boolean {
  const name = /^\/([^\s]+)/.exec(text.trim())?.[1]?.toLowerCase();
  return (
    !!name &&
    !!hosted
      ?.listSlashCommands()
      .some(
        (command) =>
          command.source === "extension" && command.name.replace(/^\/+/, "").toLowerCase() === name,
      )
  );
}
