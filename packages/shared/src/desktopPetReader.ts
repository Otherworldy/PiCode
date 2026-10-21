export interface DesktopPetPersistedSettings {
  enabled: boolean;
  packDir: string;
  packUrl: string;
  bubbleTone: "dark" | "light";
  /** 角色显示缩放。1 = 按包里的 size 渲染。 */
  displayScale: number;
  /** 只保留角色真正占用的像素，窗口和点击区贴着角色。缺省开启。 */
  cropCharacter: boolean;
  /** 摸鱼气泡的大小与位置。null 表示按角色头顶自动摆放。 */
  readerBubbleRect: DesktopPetReaderBubbleRect | null;
  /** 手动裁剪的角色舞台，按视频帧的比例记。null 表示自动按不透明像素裁剪。 */
  stageCrop: DesktopPetStageCrop | null;
  readerPath: string;
  readerHotkey: string;
  readerHotkeyMode: "toggle" | "hold";
}

/**
 * 摸鱼文本气泡相对角色的矩形。原点在角色脚底中心，宽度向右、高度向上，单位是页面像素。
 * 只影响摸鱼正文；消息提醒气泡仍按缺省摆放。
 */
export interface DesktopPetReaderBubbleRect {
  /** 气泡左边相对角色水平中心的偏移，正数向右。 */
  x: number;
  /** 气泡底边相对角色脚底的偏移，正数向上。 */
  y: number;
  w: number;
  h: number;
}

/**
 * 手动裁剪的角色舞台，取值是相对整个视频帧的比例（0–1）。
 * 所有片段共用一块裁剪，所以换动作时角色不会忽大忽小。
 */
export interface DesktopPetStageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次编辑保存下来的布局：摸鱼气泡矩形 + 角色舞台裁剪。 */
export interface DesktopPetBubbleLayout {
  rect: DesktopPetReaderBubbleRect;
  /** 保存后生效的舞台裁剪；null 表示仍按自动裁剪。 */
  stageCrop: DesktopPetStageCrop | null;
}

export const DESKTOP_PET_BUBBLE_MIN_WIDTH = 160;
export const DESKTOP_PET_BUBBLE_MAX_WIDTH = 1600;
export const DESKTOP_PET_BUBBLE_MIN_HEIGHT = 44;
export const DESKTOP_PET_BUBBLE_MAX_HEIGHT = 1200;
export const DESKTOP_PET_BUBBLE_MAX_OFFSET = 2400;

function clampNumber(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** 摸鱼气泡矩形。缺字段、类型不对或明显越界时回到自动摆放。 */
/** 舞台裁剪。四个值都在 0–1 之间且面积有效，否则回到自动裁剪。 */
export function normalizeDesktopPetStageCrop(value: unknown): DesktopPetStageCrop | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof DesktopPetStageCrop, unknown>>;
  const numbers = [raw.x, raw.y, raw.w, raw.h];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
  const x = Math.min(0.99, Math.max(0, raw.x as number));
  const y = Math.min(0.99, Math.max(0, raw.y as number));
  const w = Math.min(1 - x, Math.max(0.02, raw.w as number));
  const h = Math.min(1 - y, Math.max(0.02, raw.h as number));
  if (w <= 0 || h <= 0) return null;
  const round = (item: number) => Math.round(item * 10_000) / 10_000;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

export function normalizeDesktopPetReaderBubbleRect(
  value: unknown,
): DesktopPetReaderBubbleRect | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof DesktopPetReaderBubbleRect, unknown>>;
  const numbers = [raw.x, raw.y, raw.w, raw.h];
  if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
  return {
    x: clampNumber(raw.x as number, -DESKTOP_PET_BUBBLE_MAX_OFFSET, DESKTOP_PET_BUBBLE_MAX_OFFSET),
    y: clampNumber(raw.y as number, -DESKTOP_PET_BUBBLE_MAX_OFFSET, DESKTOP_PET_BUBBLE_MAX_OFFSET),
    w: clampNumber(raw.w as number, DESKTOP_PET_BUBBLE_MIN_WIDTH, DESKTOP_PET_BUBBLE_MAX_WIDTH),
    h: clampNumber(raw.h as number, DESKTOP_PET_BUBBLE_MIN_HEIGHT, DESKTOP_PET_BUBBLE_MAX_HEIGHT),
  };
}

export const DESKTOP_PET_DISPLAY_SCALE_DEFAULT = 1;
export const DESKTOP_PET_DISPLAY_SCALE_MIN = 0.5;
export const DESKTOP_PET_DISPLAY_SCALE_MAX = 1.5;

/** 裁剪开关。只有明确关掉才关，缺省开启。 */
export function normalizeDesktopPetCropCharacter(value: unknown): boolean {
  return value !== false;
}

/** 角色缩放。超出范围或不是数字时回到 1。 */
export function normalizeDesktopPetDisplayScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DESKTOP_PET_DISPLAY_SCALE_DEFAULT;
  const clamped = Math.min(
    DESKTOP_PET_DISPLAY_SCALE_MAX,
    Math.max(DESKTOP_PET_DISPLAY_SCALE_MIN, value),
  );
  return Math.round(clamped * 10) / 10;
}

export const DESKTOP_PET_READER_HOTKEY_DEFAULT = "F9";

const READER_HOTKEY =
  /^(?:(?:CommandOrControl|Alt|Shift|Super)\+){0,3}(?:F(?:1[0-9]|2[0-4]|[1-9])|[A-Z])$/;

/** 摸鱼快捷键。无法识别时回到 F9，避免把任意字符串注册成全局热键。 */
export function normalizeDesktopPetReaderHotkey(value: unknown): string {
  if (typeof value !== "string") return DESKTOP_PET_READER_HOTKEY_DEFAULT;
  const parts = value.trim().replace(/\s+/g, "").split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  if (!key) return DESKTOP_PET_READER_HOTKEY_DEFAULT;
  const mods = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "command") {
      return "CommandOrControl";
    }
    if (lower === "alt" || lower === "option") return "Alt";
    if (lower === "shift") return "Shift";
    if (lower === "super" || lower === "meta") return "Super";
    return "";
  });
  if (mods.some((mod) => !mod)) return DESKTOP_PET_READER_HOTKEY_DEFAULT;
  const accel = [...mods, key.length === 1 ? key.toUpperCase() : key.toUpperCase()].join("+");
  return READER_HOTKEY.test(accel) ? accel : DESKTOP_PET_READER_HOTKEY_DEFAULT;
}

/** 点击切换是按一下开、再按一下关。按住是松开才关。认不出来就用点击切换。 */
export function normalizeDesktopPetReaderHotkeyMode(value: unknown): "toggle" | "hold" {
  return value === "hold" ? "hold" : "toggle";
}
