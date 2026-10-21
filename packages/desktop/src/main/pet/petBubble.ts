/**
 * 气泡顶边。舞台已经是裁到角色本体的矩形，所以只需要知道角色顶边在舞台里的比例。
 * 比例无效时退回窗口顶部。
 */
export function petBubbleTop(input: {
  stageTop: number;
  stageHeight: number;
  /** 角色第一行不透明像素相对舞台顶边的比例（0–1）。负数表示还没量到。 */
  rowRatio: number;
  bubbleHeight: number;
}): number {
  const gap = 6;
  if (
    !Number.isFinite(input.rowRatio) ||
    input.rowRatio < 0 ||
    input.stageHeight <= 0 ||
    !Number.isFinite(input.stageTop)
  ) {
    return 8;
  }
  const ratio = Math.min(1, input.rowRatio);
  const head = input.stageTop + input.stageHeight * ratio;
  return Math.max(4, head - input.bubbleHeight - gap);
}

export type PetBubbleTone = "dark" | "light";

/** 气泡只有黑底白字和白底黑字两档，认不出来就用黑底。 */
export function petBubbleTone(value: unknown): PetBubbleTone {
  return value === "light" ? "light" : "dark";
}
