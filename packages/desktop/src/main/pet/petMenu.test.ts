import { describe, expect, it } from "vitest";
import { petContextMenu } from "./petMenu.js";

const clip = (name: string) => ({ name, url: `zcode-media://local/preview?path=${name}` });

describe("desktop pet context menu", () => {
  it("lists loaded clips and drops empty groups", () => {
    const menu = petContextMenu({
      idle: [clip("待机")],
      turn: [],
      moves: [clip("走动")],
      clicks: [clip("点击")],
      drag: [clip("  "), clip("拖拽")],
      categories: [
        { id: "玩", actions: [clip("玩耍")] },
        { id: "空", actions: [] },
      ],
    });

    expect(menu.map((entry) => entry.label)).toEqual(["待机", "移动", "点击", "拖拽", "玩"]);
    expect(menu[0]?.submenu?.[0]).toMatchObject({ label: "待机", mode: "picked" });
    expect(menu.find((entry) => entry.label === "玩")?.submenu?.[0]?.mode).toBe("picked");
  });

  it("marks turn clips so playback can flip facing", () => {
    const menu = petContextMenu({
      idle: [],
      turn: [clip("转向")],
      moves: [],
      clicks: [],
      drag: [],
      categories: [],
    });
    expect(menu[0]?.submenu?.[0]?.mode).toBe("turn");
  });
});
