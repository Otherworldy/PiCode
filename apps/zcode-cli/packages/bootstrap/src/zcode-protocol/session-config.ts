import type { CollaborationMode, ModelSelection } from "@zcode/contracts";
import type { SessionOwner } from "./session-owner.js";
import { legacyApp } from "./session-owner.js";

export function sessionMode(record: SessionOwner): CollaborationMode {
  return record.hosted
    ? (record.hosted.projector.getSnapshot().config.mode as CollaborationMode)
    : record.app.getMode();
}
export function sessionSelection(record: SessionOwner): ModelSelection | undefined {
  return record.hosted
    ? record.hosted.getCurrentModelSelection()
    : record.app.runtime.getSessionModelSelection();
}
export function sessionModel(record: SessionOwner): string {
  if (!record.hosted) return record.app.getModel();
  const selection = sessionSelection(record);
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}
export function sessionThought(record: SessionOwner): string | undefined {
  return record.hosted
    ? record.hosted.projector.getSnapshot().config.thought
    : record.app.getThoughtLevel();
}
export function sessionThoughtLevels(record: SessionOwner): string[] {
  return record.hosted
    ? [...record.hosted.projector.getSnapshot().config.thoughtLevels]
    : record.app.listThoughtLevels();
}
export function sessionPlanEnabled(record: SessionOwner): boolean {
  return record.hosted ? false : record.app.runtime.getPlanEnabled();
}
export async function setSessionMode(record: SessionOwner, mode: CollaborationMode): Promise<void> {
  if (record.hosted) {
    record.hosted.setCollaborationMode(mode);
    await record.persistMode?.(mode);
  } else await record.app.setMode(mode);
}
export async function setSessionModel(
  record: SessionOwner,
  selection: string | { providerId: string; modelId: string },
) {
  if (!record.hosted) return record.app.setModel(selection);
  const separator = typeof selection === "string" ? selection.indexOf("/") : -1;
  const provider =
    typeof selection === "string" ? selection.slice(0, separator) : selection.providerId;
  const model = typeof selection === "string" ? selection.slice(separator + 1) : selection.modelId;
  if (!provider || !model || (typeof selection === "string" && separator < 1))
    throw new Error("Model must be provider-qualified");
  await record.hosted.setModel(provider, model);
  return { thoughtLevel: sessionThought(record) };
}
export async function setSessionThought(record: SessionOwner, level: string) {
  if (!record.hosted) return record.app.setThoughtLevel(level);
  record.hosted.setThinkingLevel(level);
  return { thoughtLevel: sessionThought(record) ?? level };
}
export function sessionConfigOwner(record: SessionOwner): object {
  return record.hosted ? record.hosted : record.app;
}
export async function emitSessionModelSelected(
  record: SessionOwner,
  input: Parameters<ReturnType<typeof legacyApp>["runtime"]["emitModelSelected"]>[0],
) {
  // Pi setter 已发布真实 delta；只有旧 Core 需要补发领域事件。
  if (!record.hosted) await record.app.runtime.emitModelSelected(input);
}
export async function setSessionFollowupMode(record: SessionOwner, mode: "queue" | "guide") {
  if (!record.hosted) return record.app.setFollowupMode(mode);
  record.hosted.bridge.syncFollowupMode(mode);
  record.hosted.projector.setConfig({ followupMode: mode });
}
export async function setSessionAutoDrain(record: SessionOwner, enabled: boolean) {
  if (!record.hosted) return record.app.setQueueAutoDrain(enabled);
  record.hosted.queue.autoDrain = enabled;
  record.hosted.projector.replaceQueue(record.hosted.queue.snapshot());
}
export async function closeSessionOwner(record: SessionOwner) {
  if (record.hosted) await record.hosted.dispose();
  else await record.app.close?.();
}
export function sessionForegroundBusy(record: SessionOwner): boolean {
  return record.hosted
    ? !record.hosted.isIdle || record.hosted.projector.getSnapshot().control.phase === "running"
    : record.app.runtime.getActiveForegroundExecutionId() !== undefined;
}
