import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPetPack, petStageHeight, rollKind, stripJsonc } from "./pack.js";
import { resolveDesktopPetRootDir } from "./petRoot.js";

describe("desktop pet root", () => {
  it("uses the install directory on a packaged Windows app", () => {
    expect(
      resolveDesktopPetRootDir({
        isPackaged: true,
        platform: "win32",
        resourcesPath: "D:\\Apps\\PiCode\\resources",
        appPath: "D:\\Apps\\PiCode\\resources\\app.asar",
      }),
    ).toBe(join("D:\\Apps\\PiCode", "pets"));
  });
});

describe("pet stage height", () => {
  it("follows the clip aspect ratio instead of reserving a square", () => {
    expect(petStageHeight(16 / 9, 320)).toBe(180);
    expect(petStageHeight(1, 320)).toBe(320);
    expect(petStageHeight(16 / 9, 160)).toBe(90);
  });

  it("falls back to a square for a broken or extreme ratio", () => {
    expect(petStageHeight(0, 240)).toBe(240);
    expect(petStageHeight(Number.NaN, 240)).toBe(240);
    expect(petStageHeight(0.01, 240)).toBe(480);
  });
});

describe("desktop pet pack", () => {
  it("strips jsonc comments without eating strings", () => {
    expect(stripJsonc('{"a":"https://x","b":1}// tail\n/* c */')).toBe('{"a":"https://x","b":1}\n');
  });

  it("keeps dsh roll weights and drops turn when the pet is fixed", () => {
    const weights = { idle: 10, turn: 5, move: 5 };
    expect(rollKind(0.09, weights, false)).toBe("idle");
    expect(rollKind(0.12, weights, false)).toBe("turn");
    expect(rollKind(0.18, weights, false)).toBe("move");
    expect(rollKind(0.5, weights, false)).toBe("action");
    expect(rollKind(0.12, weights, true)).toBe("action");
  });

  it("loads click, drag, category and work-status clips from a dsh layout", () => {
    const root = mkdtempSync(join(tmpdir(), "pet-pack-"));
    const webm = join(root, "main-animation", "webm");
    mkdirSync(webm, { recursive: true });
    for (const name of ["待机", "转向", "点击", "拖拽", "走动", "玩耍", "成功"]) {
      writeFileSync(join(webm, `${name}.webm`), "webm");
    }
    writeFileSync(
      join(root, "config.jsonc"),
      `{
        // comment
        "pets": [{ "size": 900, "fixedEnabled": false }],
        "animationWeights": { "idle": 10, "turn": 5, "move": 5 },
        "animations": {
          "idle": ["待机", "缺失"],
          "turn": ["转向"],
          "drag": ["拖拽"],
          "clicks": ["点击"],
          "moves": { "actions": [{ "name": "走动" }] },
          "categories": [{ "id": "玩", "weight": 20, "actions": ["玩耍"] }],
          "events": { "workStatus": ["缺失", ["成功", "玩耍"]] }
        }
      }`,
    );

    const pack = loadPetPack(root);
    expect(pack?.size).toBe(320);
    // 测试里写的是假 webm，读不到像素尺寸时把比例当正方形。
    expect(pack?.aspect).toBe(1);
    expect(pack?.idle.map((clip) => clip.name)).toEqual(["待机"]);
    expect(pack?.clicks.map((clip) => clip.name)).toEqual(["点击"]);
    expect(pack?.drag.map((clip) => clip.name)).toEqual(["拖拽"]);
    expect(pack?.moves.map((clip) => clip.name)).toEqual(["走动"]);
    expect(pack?.categories[0]?.actions.map((clip) => clip.name)).toEqual(["玩耍"]);
    expect(pack?.workStatus[0]).toEqual([]);
    expect(pack?.workStatus[1]?.map((clip) => clip.name)).toEqual(["成功", "玩耍"]);
  });

  it("takes the aspect ratio from the real idle clip header", () => {
    const root = mkdtempSync(join(tmpdir(), "pet-aspect-"));
    const webm = join(root, "webm");
    mkdirSync(webm, { recursive: true });
    writeFileSync(join(webm, "待机.webm"), buildWebmFixture(640, 360));
    writeFileSync(
      join(root, "config.jsonc"),
      `{ "pets": [{ "size": 320 }], "animations": { "idle": ["待机"] } }`,
    );

    const pack = loadPetPack(root);
    expect(pack?.aspect).toBeCloseTo(640 / 360);
    expect(petStageHeight(pack?.aspect ?? 1, pack?.size ?? 320)).toBe(180);
  });
});

/** 最小 EBML：Segment → Tracks → TrackEntry → Video → PixelWidth/Height。 */
function buildWebmFixture(width: number, height: number): Buffer {
  const uint = (id: number, value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    while (rest > 0) {
      bytes.unshift(rest & 0xff);
      rest = Math.floor(rest / 256);
    }
    const payload = bytes.length ? bytes : [0];
    return [id, 0x80 | payload.length, ...payload];
  };
  const master = (id: number[], children: number[]): number[] => {
    const size = children.length;
    const sizeBytes = size < 0x7f ? [0x80 | size] : [0x40 | (size >> 8), size & 0xff];
    return [...id, ...sizeBytes, ...children];
  };
  const video = master([0xe0], [...uint(0xb0, width), ...uint(0xba, height)]);
  const tracks = master([0x16, 0x54, 0xae, 0x6b], master([0xae], video));
  return Buffer.from(master([0x18, 0x53, 0x80, 0x67], tracks));
}
