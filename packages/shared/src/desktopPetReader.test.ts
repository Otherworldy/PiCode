import { describe, expect, it } from "vitest";
import {
  DESKTOP_PET_AUTO_PAGE_MS_DEFAULT,
  DESKTOP_PET_AUTO_PAGE_MS_MAX,
  DESKTOP_PET_AUTO_PAGE_MS_MIN,
  DESKTOP_PET_READER_FONT_SIZE_DEFAULT,
  DESKTOP_PET_READER_FONT_SIZE_MAX,
  DESKTOP_PET_READER_FONT_SIZE_MIN,
  DESKTOP_PET_READER_LETTER_SPACING_MAX,
  DESKTOP_PET_READER_LINE_HEIGHT_MAX,
  DESKTOP_PET_READER_LINE_HEIGHT_MIN,
  desktopPetAutoPageMs,
  desktopPetReaderTextMetrics,
  normalizeDesktopPetAutoPageMs,
  normalizeDesktopPetReaderFontSize,
  normalizeDesktopPetReaderLetterSpacing,
  normalizeDesktopPetReaderLineHeight,
} from "./desktopPetReader.js";

describe("desktop pet auto page", () => {
  it("clamps the interval into the allowed range", () => {
    expect(normalizeDesktopPetAutoPageMs(1200)).toBe(1200);
    expect(normalizeDesktopPetAutoPageMs("800")).toBe(800);
    expect(normalizeDesktopPetAutoPageMs(1)).toBe(DESKTOP_PET_AUTO_PAGE_MS_MIN);
    expect(normalizeDesktopPetAutoPageMs(999999)).toBe(DESKTOP_PET_AUTO_PAGE_MS_MAX);
    expect(normalizeDesktopPetAutoPageMs("")).toBe(DESKTOP_PET_AUTO_PAGE_MS_DEFAULT);
    expect(normalizeDesktopPetAutoPageMs(undefined)).toBe(DESKTOP_PET_AUTO_PAGE_MS_DEFAULT);
    expect(normalizeDesktopPetAutoPageMs(Number.NaN)).toBe(DESKTOP_PET_AUTO_PAGE_MS_DEFAULT);
  });

  it("only auto pages while holding the shortcut", () => {
    const base = { readerAutoPage: true, readerAutoPageMs: 900 };
    expect(desktopPetAutoPageMs({ ...base, readerHotkeyMode: "hold" })).toBe(900);
    expect(desktopPetAutoPageMs({ ...base, readerHotkeyMode: "toggle" })).toBe(0);
    expect(desktopPetAutoPageMs({ ...base, readerAutoPage: false, readerHotkeyMode: "hold" })).toBe(
      0,
    );
    expect(desktopPetAutoPageMs({ ...base, readerHotkeyMode: "hold", readerAutoPageMs: 5 })).toBe(
      DESKTOP_PET_AUTO_PAGE_MS_MIN,
    );
  });
});

describe("desktop pet reader text style", () => {
  it("clamps the font size, line ratio and letter spacing", () => {
    expect(normalizeDesktopPetReaderFontSize(14)).toBe(14);
    expect(normalizeDesktopPetReaderFontSize("16")).toBe(16);
    expect(normalizeDesktopPetReaderFontSize(2)).toBe(DESKTOP_PET_READER_FONT_SIZE_MIN);
    expect(normalizeDesktopPetReaderFontSize(99)).toBe(DESKTOP_PET_READER_FONT_SIZE_MAX);
    expect(normalizeDesktopPetReaderFontSize("")).toBe(DESKTOP_PET_READER_FONT_SIZE_DEFAULT);
    expect(normalizeDesktopPetReaderFontSize(undefined)).toBe(DESKTOP_PET_READER_FONT_SIZE_DEFAULT);

    expect(normalizeDesktopPetReaderLineHeight(1.5)).toBe(1.5);
    expect(normalizeDesktopPetReaderLineHeight(0.1)).toBe(DESKTOP_PET_READER_LINE_HEIGHT_MIN);
    expect(normalizeDesktopPetReaderLineHeight(9)).toBe(DESKTOP_PET_READER_LINE_HEIGHT_MAX);
    expect(normalizeDesktopPetReaderLineHeight("abc")).toBeCloseTo(1.35, 5);

    expect(normalizeDesktopPetReaderLetterSpacing(1.5)).toBe(1.5);
    expect(normalizeDesktopPetReaderLetterSpacing(-3)).toBe(0);
    expect(normalizeDesktopPetReaderLetterSpacing(99)).toBe(DESKTOP_PET_READER_LETTER_SPACING_MAX);
    expect(normalizeDesktopPetReaderLetterSpacing(null)).toBe(0);
  });

  it("keeps the default metrics identical to the old fixed 12/16 layout", () => {
    const metrics = desktopPetReaderTextMetrics({
      readerFontSize: DESKTOP_PET_READER_FONT_SIZE_DEFAULT,
      readerLineHeight: 1.35,
      readerLetterSpacing: 0,
    });
    expect(metrics).toEqual({ fontSize: 12, lineHeight: 16, letterSpacing: 0 });
  });

  it("rounds the line height to whole pixels and clamps the ratio", () => {
    expect(
      desktopPetReaderTextMetrics({
        readerFontSize: 15,
        readerLineHeight: 1.6,
        readerLetterSpacing: 0,
      }).lineHeight,
    ).toBe(24);
    expect(
      desktopPetReaderTextMetrics({
        readerFontSize: 16,
        readerLineHeight: 1.2,
        readerLetterSpacing: 0,
      }).lineHeight,
    ).toBe(19);
    // 行距低于下限时先夹到 1.2，再乘出整行高。
    expect(
      desktopPetReaderTextMetrics({
        readerFontSize: 20,
        readerLineHeight: 1,
        readerLetterSpacing: 0,
      }).lineHeight,
    ).toBe(24);
  });
});
