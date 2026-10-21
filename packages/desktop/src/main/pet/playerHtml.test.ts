import { describe, expect, it } from "vitest";
import { petWindowLayout, snapBubbleHeight } from "./bubbleGeometry.js";
import {
  PET_BUBBLE_GAP,
  PET_BUBBLE_HEIGHT,
  PET_BUBBLE_INSET,
  PET_BUBBLE_LINE_HEIGHT,
  PET_BUBBLE_MARGIN,
  PET_BUBBLE_PADDING_Y,
  petBubbleTone,
} from "./petBubble.js";
import { renderPetPlayerHtml } from "./playerHtml.js";

const stage = { stageWidth: 107, stageHeight: 137, defaultWidth: 320 };

describe("pet window layout", () => {
  it("puts the default bubble above the character", () => {
    const layout = petWindowLayout({
      ...stage,
      rect: null,
      bubbleHeight: PET_BUBBLE_HEIGHT,
      gap: PET_BUBBLE_GAP,
      inset: PET_BUBBLE_INSET,
      margin: PET_BUBBLE_MARGIN,
    });
    // 气泡宽 320 - 16 = 304，窗口按并集算：304 + 两边 4px 透明边。
    expect(layout.width).toBe(312);
    expect(layout.height).toBe(137 + PET_BUBBLE_GAP + PET_BUBBLE_HEIGHT + PET_BUBBLE_MARGIN * 2);
    expect(layout.stageLeft).toBe(Math.round((312 - 107) / 2));
    expect(layout.stageBottom).toBe(PET_BUBBLE_MARGIN);
    // 气泡底边离角色顶边的间隙保持不变。
    expect(layout.auto.bottom).toBe(
      layout.stageBottom + 137 + PET_BUBBLE_GAP - PET_BUBBLE_MARGIN + PET_BUBBLE_MARGIN,
    );
    expect(layout.reader).toEqual(layout.auto);
  });

  it("grows the window around a custom bubble", () => {
    const layout = petWindowLayout({
      ...stage,
      rect: { x: -300, y: -40, w: 200, h: 124 },
      bubbleHeight: PET_BUBBLE_HEIGHT,
      gap: PET_BUBBLE_GAP,
      inset: PET_BUBBLE_INSET,
      margin: PET_BUBBLE_MARGIN,
    });
    expect(layout.reader.width).toBe(200);
    expect(layout.reader.height).toBe(124);
    // 左边到 -300，右边沿用缺省气泡的 152。
    expect(layout.width).toBe(152 + 300 + PET_BUBBLE_MARGIN * 2);
    expect(layout.reader.left).toBe(PET_BUBBLE_MARGIN);
    // 气泡压到角色脚底以下，窗口往下长，角色跟着抬高。
    expect(layout.stageBottom).toBe(40 + PET_BUBBLE_MARGIN);
  });

  it("keeps the default bubble inside the window even with a custom reader rect", () => {
    const layout = petWindowLayout({
      ...stage,
      rect: { x: 0, y: 200, w: 180, h: 60 },
      bubbleHeight: PET_BUBBLE_HEIGHT,
      gap: PET_BUBBLE_GAP,
      inset: PET_BUBBLE_INSET,
      margin: PET_BUBBLE_MARGIN,
    });
    expect(layout.auto.bottom).toBeGreaterThan(layout.stageBottom + 137);
    expect(layout.height).toBeGreaterThanOrEqual(layout.reader.bottom + layout.reader.height);
    expect(layout.height).toBeGreaterThanOrEqual(layout.auto.bottom + layout.auto.height);
  });

  it("snaps bubble height to whole lines", () => {
    expect(snapBubbleHeight(100, PET_BUBBLE_LINE_HEIGHT, PET_BUBBLE_PADDING_Y, 2)).toBe(
      PET_BUBBLE_PADDING_Y * 2 + PET_BUBBLE_LINE_HEIGHT * 6,
    );
    expect(snapBubbleHeight(10, PET_BUBBLE_LINE_HEIGHT, PET_BUBBLE_PADDING_Y, 2)).toBe(
      PET_BUBBLE_PADDING_Y * 2 + PET_BUBBLE_LINE_HEIGHT * 2,
    );
  });
});

describe("pet bubble", () => {
  it("embeds the layout function in the player", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain("function petWindowLayout");
    expect(html).toContain("function snapBubbleHeight");
  });

  it("keeps a whole number of lines inside the default bubble", () => {
    expect(PET_BUBBLE_HEIGHT - PET_BUBBLE_PADDING_Y * 2).toBe(PET_BUBBLE_LINE_HEIGHT * 4);
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain(`font: 12px/${PET_BUBBLE_LINE_HEIGHT}px sans-serif`);
    expect(html).toContain(`const LINE = ${PET_BUBBLE_LINE_HEIGHT};`);
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
    expect(html).toContain("Math.floor(cur / LINE) + 1");
    expect(html).toContain("Math.ceil(cur / LINE) - 1");
  });

  it("sizes the stage to the character area so the empty bands are not clickable", () => {
    const html = renderPetPlayerHtml('{"stage":{"width":320,"height":180}}');
    expect(html).toContain('id="stage"');
    expect(html).toContain("function measureBox");
    expect(html).toContain('type: "box"');
    expect(html).toContain('stage.addEventListener("pointerdown"');
  });

  it("enters a drag-to-resize bubble editor from the settings page", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('type === "bubble-edit"');
    expect(html).toContain('type: "bubble-edit-done"');
    expect(html).toContain('type: "bubble-edit-cancel"');
    expect(html).toContain('id="edit-save"');
    expect(html).toContain('id="edit-cancel"');
    expect(html).toContain("function startEditDrag");
  });

  it("reports the stage and bubble rectangles as the window shape", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain("function reportShape");
    expect(html).toContain('type: "shape"');
    // 空白区不接管桌面点击，靠的是窗口形状而不是鼠标移动。
    expect(html).not.toContain("setIgnoreMouseEvents");
  });

  it("can crop the character stage in the same editor", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('id="crop-box"');
    expect(html).toContain("function resizeCrop");
    expect(html).toContain("cropHandles");
    // 没动过裁剪框就不写裁剪，避免把自动按片段量出来的框写死。
    expect(html).toContain("cropChanged");
    expect(html).toContain("stageCrop:");
  });

  it("keeps a session mood without covering the bubble", () => {
    const html = renderPetPlayerHtml("{}");
    expect(html).toContain('type === "mood"');
    expect(html).toContain("state.mood");
  });
});
