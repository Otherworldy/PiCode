import type { SessionSummary } from "./zcode-protocol-v4/sessions-index.js";

/** 桌面宠物的持续心情。完成和失败不是心情，它们仍是一次性提醒。 */
export type DesktopPetMood = "idle" | "thinking" | "busy" | "waiting";

type MoodSession = Pick<
  SessionSummary,
  "phase" | "hasBackgroundWork" | "pendingInteractionSummary" | "pendingInteraction"
>;

export function normalizeDesktopPetMood(value: unknown): DesktopPetMood {
  return value === "thinking" || value === "busy" || value === "waiting" ? value : "idle";
}

function sessionIsWaiting(session: MoodSession): boolean {
  const summary = session.pendingInteractionSummary;
  if (summary) return summary.permissionCount > 0 || summary.userInputCount > 0;
  return session.pendingInteraction != null;
}

/** 一个工作区里的会话合成一种心情。等人高于正在跑的回合，回合高于后台工作。 */
export function deriveDesktopPetMood(sessions: readonly MoodSession[]): DesktopPetMood {
  let thinking = false;
  let busy = false;
  for (const session of sessions) {
    if (sessionIsWaiting(session)) return "waiting";
    if (session.phase === "running" || session.phase === "prewarming") thinking = true;
    else if (session.hasBackgroundWork) busy = true;
  }
  if (thinking) return "thinking";
  if (busy) return "busy";
  return "idle";
}

/** 多窗口各报一份心情。同一档不挑窗口，只保留最高档。 */
export function mergeDesktopPetMoods(moods: readonly DesktopPetMood[]): DesktopPetMood {
  if (moods.includes("waiting")) return "waiting";
  if (moods.includes("thinking")) return "thinking";
  if (moods.includes("busy")) return "busy";
  return "idle";
}

/**
 * 心情对应的工作状态槽。空槽退回下一档，不用更低的槽顶上。
 * 返回 null 表示回到随机待机。
 */
export function desktopPetMoodSlot(
  mood: DesktopPetMood,
  slotLengths: readonly number[],
): number | null {
  const order =
    mood === "waiting" ? [3, 0, 1] : mood === "thinking" ? [0, 1] : mood === "busy" ? [1] : [];
  for (const index of order) {
    if ((slotLengths[index] ?? 0) > 0) return index;
  }
  return null;
}
