import { describe, expect, it } from "vitest";
import {
  DESKTOP_PET_AUTO_PAGE_MS_DEFAULT,
  DESKTOP_PET_AUTO_PAGE_MS_MAX,
  DESKTOP_PET_AUTO_PAGE_MS_MIN,
  desktopPetAutoPageMs,
  normalizeDesktopPetAutoPageMs,
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
