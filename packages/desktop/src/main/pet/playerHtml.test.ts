import { describe, expect, it } from "vitest";
import { petBubbleTone, petBubbleTop, renderPetPlayerHtml } from "./playerHtml.js";

const stage = {
  stageTop: 64,
  stageWidth: 320,
  stageHeight: 320,
  videoWidth: 320,
  videoHeight: 320,
  bubbleHeight: 40,
};

describe("pet bubble", () => {
  it("sits just above the visible character instead of the window top", () => {
    expect(petBubbleTop({ ...stage, opaqueRow: 180 })).toBe(198);
    expect(petBubbleTop({ ...stage, opaqueRow: 0 })).toBe(18);
  });

  it("stays in the reserved strip when the frame has no visible pixels yet", () => {
    expect(petBubbleTop({ ...stage, opaqueRow: -1 })).toBe(8);
  });

  it("embeds the same placement function in the player", () => {
    expect(renderPetPlayerHtml("{}")).toContain(petBubbleTop.toString());
  });

  it("defaults to a black bubble and can switch to white", () => {
    expect(petBubbleTone("light")).toBe("light");
    expect(petBubbleTone("nope")).toBe("dark");
    expect(renderPetPlayerHtml("{}")).toContain('data-tone="dark"');
    expect(renderPetPlayerHtml("{}", "light")).toContain('data-tone="light"');
  });

  it("scrolls novel text inside the existing bubble", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('data-mode="read"');
    expect(html).toContain('type === "read-hide"');
    expect(html).toContain('type: "read-page"');
  });

  it("keeps a session mood without covering the bubble", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('type === "mood"');
    expect(html).toContain("state.mood");
  });
});
