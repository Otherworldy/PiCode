/** 气泡里每行的高度。气泡高度和滚动都按整行走，不会停在半行上。 */
export const PET_BUBBLE_LINE_HEIGHT = 16;
/** 气泡最多露出的行数。 */
export const PET_BUBBLE_LINES = 4;
/** 气泡上下内边距。 */
export const PET_BUBBLE_PADDING_Y = 6;
/** 气泡最大高度（含内边距）。正文区正好是行高的整数倍。 */
export const PET_BUBBLE_HEIGHT =
  PET_BUBBLE_LINE_HEIGHT * PET_BUBBLE_LINES + PET_BUBBLE_PADDING_Y * 2;
/** 角色顶边到气泡底边的间隙。 */
export const PET_BUBBLE_GAP = 6;
/** 窗口顶部到气泡顶边的边距。 */
export const PET_BUBBLE_MARGIN = 6;
/** 窗口里给气泡留的高度：角色顶边以上这块。 */
export const PET_BUBBLE_SPACE = PET_BUBBLE_HEIGHT + PET_BUBBLE_GAP + PET_BUBBLE_MARGIN;

/**
 * 气泡顶边。舞台已经是裁到角色本体的矩形，所以只需要知道角色顶边在舞台里的比例。
 * 比例无效时退回窗口顶部。
 * 这个函数会被 toString() 内联到播放页，所以间隙和上边距要从调用方传进来，不能引用模块常量。
 */
export function petBubbleTop(input: {
  stageTop: number;
  stageHeight: number;
  /** 角色第一行不透明像素相对舞台顶边的比例（0–1）。负数表示还没量到。 */
  rowRatio: number;
  bubbleHeight: number;
  /** 角色顶边到气泡底边的间隙，缺省 6。 */
  gap?: number;
  /** 气泡至少离窗口顶边多远，缺省 6。 */
  minTop?: number;
}): number {
  const gap = typeof input.gap === "number" ? input.gap : 6;
  const minTop = typeof input.minTop === "number" ? input.minTop : 6;
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
  return Math.max(minTop, head - input.bubbleHeight - gap);
}

export type PetBubbleTone = "dark" | "light";

/** 气泡只有黑底白字和白底黑字两档，认不出来就用黑底。 */
export function petBubbleTone(value: unknown): PetBubbleTone {
  return value === "light" ? "light" : "dark";
}
