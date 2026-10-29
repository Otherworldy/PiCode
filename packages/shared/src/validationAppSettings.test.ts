import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";

/**
 * 宠物设置全部走 setting.json，schema 里漏一个字段就等于那次改动被静默丢掉。
 * 这里把已知字段整份过一遍两个 schema，加字段时同步加进来。
 */
const petSettings = {
  desktopPetEnabled: true,
  desktopPetPackDir: "/pets",
  desktopPetPackUrl: "https://example.test/pet.zip",
  desktopPetBubbleTone: "light",
  desktopPetDisplayScale: 1.2,
  desktopPetCropCharacter: false,
  desktopPetReaderBubbleRect: { x: 1, y: 2, w: 320, h: 76 },
  desktopPetStageCrop: { x: 0, y: 0, w: 1, h: 1 },
  desktopPetReaderPath: "/books/a.txt",
  desktopPetReaderHotkey: "F9",
  desktopPetReaderHotkeyMode: "hold",
  desktopPetReaderAutoPage: true,
  desktopPetReaderAutoPageMs: 1500,
  desktopPetReaderFontSize: 14,
  desktopPetReaderLineHeight: 1.6,
  desktopPetReaderLetterSpacing: 1,
} as const;

describe("desktop pet app settings", () => {
  it("keeps every desktop pet field in the patch schema", () => {
    const patch = appSettingsPatchSchema.parse(petSettings) as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(Object.keys(petSettings).sort());
  });

  it("keeps every desktop pet field in the full schema", () => {
    const full = appSettingsSchema.parse(petSettings) as Record<string, unknown>;
    for (const [key, value] of Object.entries(petSettings)) {
      expect(full[key]).toEqual(value);
    }
  });
});
