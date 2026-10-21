import { describe, expect, it } from "vitest";
import { petBubbleTone, petBubbleTop, renderPetPlayerHtml } from "./playerHtml.js";

const stage = {
  stageTop: 64,
  stageHeight: 320,
  bubbleHeight: 40,
};

describe("pet bubble", () => {
  it("sits just above the visible character instead of the window top", () => {
    // 角色顶边在舞台 56.25% 处：64 + 320 * 0.5625 = 244，再减气泡高与 6px 间隙。
    expect(petBubbleTop({ ...stage, rowRatio: 0.5625 })).toBe(198);
    expect(petBubbleTop({ ...stage, rowRatio: 0 })).toBe(18);
  });

  it("stays in the reserved strip when the frame has no visible pixels yet", () => {
    expect(petBubbleTop({ ...stage, rowRatio: -1 })).toBe(8);
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

  it("sizes the stage to the character area so the empty bands are not clickable", () => {
    const html = renderPetPlayerHtml('{"stage":{"width":320,"height":180}}');
    expect(html).toContain('id="frame"');
    expect(html).toContain("function measureBox");
    expect(html).toContain('type: "box"');
    expect(html).toContain('stage.addEventListener("pointerdown"');
  });

  it("keeps a session mood without covering the bubble", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('type === "mood"');
    expect(html).toContain("state.mood");
  });
});
