export interface DesktopPetPersistedSettings {
  enabled: boolean;
  packDir: string;
  packUrl: string;
  bubbleTone: "dark" | "light";
  readerPath: string;
  readerHotkey: string;
  readerHotkeyMode: "toggle" | "hold";
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
