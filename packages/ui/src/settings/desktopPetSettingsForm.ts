import {
  normalizeDesktopPetCropCharacter,
  normalizeDesktopPetDisplayScale,
  normalizeDesktopPetReaderBubbleRect,
  normalizeDesktopPetReaderHotkey,
  normalizeDesktopPetReaderHotkeyMode,
  type AppSettings,
  type DesktopPetPersistedSettings,
} from "@zcode/shared";

/** 设置页表单只认自己这几个字段；旧进程可能把它们整份写没，所以都给缺省值。 */
export function petFormFromSettings(
  settings: Partial<AppSettings> | null | undefined,
): DesktopPetPersistedSettings {
  return {
    enabled: settings?.desktopPetEnabled === true,
    packDir: settings?.desktopPetPackDir?.trim() ?? "",
    packUrl: settings?.desktopPetPackUrl?.trim() ?? "",
    bubbleTone: settings?.desktopPetBubbleTone === "light" ? "light" : "dark",
    displayScale: normalizeDesktopPetDisplayScale(settings?.desktopPetDisplayScale),
    cropCharacter: normalizeDesktopPetCropCharacter(settings?.desktopPetCropCharacter),
    readerBubbleRect: normalizeDesktopPetReaderBubbleRect(settings?.desktopPetReaderBubbleRect),
    readerPath: settings?.desktopPetReaderPath?.trim() ?? "",
    readerHotkey: normalizeDesktopPetReaderHotkey(settings?.desktopPetReaderHotkey),
    readerHotkeyMode: normalizeDesktopPetReaderHotkeyMode(settings?.desktopPetReaderHotkeyMode),
  };
}
