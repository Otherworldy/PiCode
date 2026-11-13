import type { HostQueue } from "./host-queue.js";
import type { PiSessionPort } from "./types.js";

function reloadError(reasonCode: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    reasonCode,
  });
}

/** SDK 重载会失效旧扩展，必须和输入消费使用同一把锁，不能只依赖 Renderer 的 busy 显示。 */
export async function reloadHostedSessionResources(input: {
  pi: PiSessionPort;
  queue: HostQueue;
  hasBlockingWork(): boolean;
  afterReload(): void;
}): Promise<void> {
  if (input.hasBlockingWork()) {
    throw reloadError(
      "guard.sessionReloadBusy",
      "The session has active work, queued input, or pending interactions. Retry after it is idle.",
    );
  }
  if (!input.pi.reloadResources) {
    throw reloadError(
      "fault.command.sessionReloadUnsupported",
      "This session does not support resource reload.",
    );
  }
  const consumer = input.queue.tryAcquireConsumer();
  if (!consumer) {
    throw reloadError(
      "guard.sessionReloadBusy",
      "The session is admitting input. Retry after it is idle.",
    );
  }
  try {
    await input.pi.reloadResources();
    input.afterReload();
  } catch (error) {
    throw reloadError(
      "fault.command.sessionReloadFailed",
      error instanceof Error ? error.message : String(error),
      error,
    );
  } finally {
    consumer.release();
  }
}
