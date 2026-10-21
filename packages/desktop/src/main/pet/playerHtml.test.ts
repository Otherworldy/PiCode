import { describe, expect, it } from "vitest";
import {
  PET_BUBBLE_GAP,
  PET_BUBBLE_HEIGHT,
  PET_BUBBLE_LINE_HEIGHT,
  PET_BUBBLE_MARGIN,
  PET_BUBBLE_SPACE,
  petBubbleTone,
  petBubbleTop,
} from "./petBubble.js";
import { renderPetPlayerHtml } from "./playerHtml.js";

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
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain(petBubbleTop.toString());
    // 内联的函数不能引用模块常量，间隙和上边距由模板传进去。
    expect(html).toContain(`gap: ${PET_BUBBLE_GAP},`);
    expect(html).toContain(`minTop: ${PET_BUBBLE_MARGIN},`);
  });

  it("keeps room for whole bubble lines above the character", () => {
    // 正文区正好是行高的整数倍，滚动不会停在半行上。
    expect(PET_BUBBLE_HEIGHT - 12).toBe(PET_BUBBLE_LINE_HEIGHT * 4);
    expect(PET_BUBBLE_SPACE).toBe(PET_BUBBLE_HEIGHT + PET_BUBBLE_GAP + PET_BUBBLE_MARGIN);
    expect(
      petBubbleTop({
        stageTop: PET_BUBBLE_SPACE,
        stageHeight: 137,
        rowRatio: 0,
        bubbleHeight: PET_BUBBLE_HEIGHT,
      }),
    ).toBe(PET_BUBBLE_SPACE - PET_BUBBLE_HEIGHT - PET_BUBBLE_GAP);

    const html = renderPetPlayerHtml("{}");
    expect(html).toContain(`top: ${PET_BUBBLE_SPACE}px`);
    expect(html).toContain(`max-height: ${PET_BUBBLE_HEIGHT}px`);
    expect(html).toContain(`font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif`);
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
    // 滚一格正好一行，且总是落在行边界上。
    expect(html).toContain(`const LINE = ${PET_BUBBLE_LINE_HEIGHT};`);
    expect(html).toContain("Math.floor(cur / LINE) + 1");
    expect(html).toContain("Math.ceil(cur / LINE) - 1");
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
