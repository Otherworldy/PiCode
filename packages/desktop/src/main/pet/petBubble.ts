/** 气泡里每行的高度。气泡高度和滚动都按整行走，不会停在半行上。 */
export const PET_BUBBLE_LINE_HEIGHT = 16;
/** 缺省气泡露出的行数。 */
export const PET_BUBBLE_LINES = 4;
/** 气泡上下内边距。 */
export const PET_BUBBLE_PADDING_Y = 6;
/** 缺省气泡高度（含内边距）。正文区正好是行高的整数倍。 */
export const PET_BUBBLE_HEIGHT =
  PET_BUBBLE_LINE_HEIGHT * PET_BUBBLE_LINES + PET_BUBBLE_PADDING_Y * 2;
/** 缺省摆放时，角色顶边到气泡底边的间隙。 */
export const PET_BUBBLE_GAP = 6;
/** 缺省摆放时，气泡左右离画面宽度的边距。 */
export const PET_BUBBLE_INSET = 8;
/** 窗口四边留一点透明边，白底气泡的投影不会被窗口边缘切掉。 */
export const PET_BUBBLE_MARGIN = 4;

export type PetBubbleTone = "dark" | "light";

/** 气泡只有黑底白字和白底黑字两档，认不出来就用黑底。 */
export function petBubbleTone(value: unknown): PetBubbleTone {
  return value === "light" ? "light" : "dark";
}

/** 气泡编辑态上的文字。播放页是独立 HTML，拿不到 renderer 的 i18n，只能由主进程按当前语言传进去。 */
export interface PetBubbleEditLabels {
  bar: string;
  save: string;
  cancel: string;
  bubble: string;
  window: string;
}

export function petBubbleEditLabels(locale: string): PetBubbleEditLabels {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      bar: "拖动气泡移动，拖动方块缩放",
      save: "保存",
      cancel: "取消",
      bubble: "气泡 {w} × {h}",
      window: "窗口 {w} × {h}",
    };
  }
  return {
    bar: "Drag the bubble to move, drag the handles to resize",
    save: "Save",
    cancel: "Cancel",
    bubble: "Bubble {w} × {h}",
    window: "Window {w} × {h}",
  };
}
