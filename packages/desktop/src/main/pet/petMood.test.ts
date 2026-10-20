import { deriveDesktopPetMood, desktopPetMoodSlot, mergeDesktopPetMoods } from "@zcode/shared";
import { describe, expect, it } from "vitest";

const quiet = { phase: "completedSuccess" as const, hasBackgroundWork: false };

describe("desktop pet mood", () => {
  it("keeps the highest mood across sessions", () => {
    expect(deriveDesktopPetMood([])).toBe("idle");
    expect(deriveDesktopPetMood([quiet])).toBe("idle");
    expect(deriveDesktopPetMood([{ phase: "error", hasBackgroundWork: false }])).toBe("idle");
    expect(
      deriveDesktopPetMood([quiet, { phase: "completedSuccess", hasBackgroundWork: true }]),
    ).toBe("busy");
    expect(
      deriveDesktopPetMood([
        { phase: "completedSuccess", hasBackgroundWork: true },
        { phase: "running", hasBackgroundWork: false },
        { phase: "prewarming", hasBackgroundWork: false },
      ]),
    ).toBe("thinking");
    expect(
      deriveDesktopPetMood([
        { phase: "running", hasBackgroundWork: false },
        {
          phase: "completedSuccess",
          hasBackgroundWork: false,
          pendingInteractionSummary: { permissionCount: 1, userInputCount: 0 },
        },
      ]),
    ).toBe("waiting");
    expect(
      deriveDesktopPetMood([
        {
          phase: "running",
          hasBackgroundWork: false,
          pendingInteractionSummary: { permissionCount: 0, userInputCount: 1 },
        },
      ]),
    ).toBe("waiting");
    expect(
      deriveDesktopPetMood([
        {
          phase: "completedSuccess",
          hasBackgroundWork: false,
          pendingInteraction: { interactionId: "ask", kind: "userInput" },
        },
      ]),
    ).toBe("waiting");
  });

  it("merges windows by the same priority and skips empty slots", () => {
    expect(mergeDesktopPetMoods(["idle", "busy", "thinking"])).toBe("thinking");
    expect(mergeDesktopPetMoods(["thinking", "waiting"])).toBe("waiting");
    expect(mergeDesktopPetMoods([])).toBe("idle");
    expect(desktopPetMoodSlot("idle", [1, 1, 1, 1])).toBeNull();
    expect(desktopPetMoodSlot("thinking", [2, 1])).toBe(0);
    expect(desktopPetMoodSlot("thinking", [0, 2])).toBe(1);
    expect(desktopPetMoodSlot("busy", [2, 0])).toBeNull();
    expect(desktopPetMoodSlot("waiting", [1, 1, 0, 0])).toBe(0);
    expect(desktopPetMoodSlot("waiting", [0, 1, 0, 2])).toBe(3);
    expect(desktopPetMoodSlot("waiting", [])).toBeNull();
  });
});
