export interface DesktopPetPersistedSettings {
  enabled: boolean;
  packDir: string;
  packUrl: string;
  bubbleTone: "dark" | "light";
  /** 角色显示缩放。1 = 按包里的 size 渲染。 */
  displayScale: number;
  /** 只保留角色真正占用的像素，窗口和点击区贴着角色。缺省开启。 */
  cropCharacter: boolean;
  readerPath: string;
  readerHotkey: string;
  readerHotkeyMode: "toggle" | "hold";
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
