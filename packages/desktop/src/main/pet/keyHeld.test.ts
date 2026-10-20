import { normalizeDesktopPetReaderHotkeyMode } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { noteHoldPress, pollHoldLatch, readerHoldChord, startReaderHoldProbe } from "./keyHeld.js";

describe("pet reader hold", () => {
  it("keeps the bubble while the key is down and closes after release", () => {
    const pressed = noteHoldPress(1_000);
    const stillDown = pollHoldLatch(pressed, true, true, 1_020);
    expect(stillDown.release).toBe(false);
    expect(stillDown.state.seenDown).toBe(true);
    const released = pollHoldLatch(stillDown.state, false, true, 1_050);
    expect(released.release).toBe(true);
    expect(released.state.latched).toBe(false);
  });

  it("waits briefly for the first down sample so a stale up reading does not close immediately", () => {
    const pressed = noteHoldPress(1_000);
    expect(pollHoldLatch(pressed, false, true, 1_100).release).toBe(false);
    expect(pollHoldLatch(pressed, false, true, 1_300).release).toBe(true);
    expect(pollHoldLatch(pressed, false, false, 1_010).release).toBe(true);
  });

  it("maps the shortcut to platform key codes", () => {
    expect(readerHoldChord("F9", "win32")).toBe("120");
    expect(readerHoldChord("CommandOrControl+Alt+F2", "win32")).toBe("17;18;113");
    expect(readerHoldChord("F9", "darwin")).toBe("101");
    expect(readerHoldChord("F9", "linux")).toBeNull();
    expect(normalizeDesktopPetReaderHotkeyMode("hold")).toBe("hold");
    expect(normalizeDesktopPetReaderHotkeyMode("nope")).toBe("toggle");
  });

  it("reads a released key on windows", async () => {
    if (process.platform !== "win32") return;
    const probe = startReaderHoldProbe("F13");
    expect(probe).not.toBeNull();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(probe?.alive()).toBe(true);
      expect(probe?.down()).toBe(false);
    } finally {
      probe?.stop();
    }
  }, 8_000);
});
