import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSize, readWebmSize } from "./webmSize.js";

/** 最小可解析的 EBML：Segment → Tracks → TrackEntry → Video → PixelWidth/Height。 */
function buildWebm(width: number, height: number): Buffer {
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
  const track = master([0xae], video);
  const tracks = master([0x16, 0x54, 0xae, 0x6b], track);
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
  return Buffer.from([...header, ...master([0x18, 0x53, 0x80, 0x67], tracks)]);
}

describe("webm size", () => {
  it("reads pixel dimensions from the Tracks header", () => {
    expect(parseSize(buildWebm(640, 360))).toEqual({ width: 640, height: 360 });
    expect(parseSize(buildWebm(320, 320))).toEqual({ width: 320, height: 320 });
  });

  it("returns null for a buffer without video dimensions", () => {
    expect(parseSize(Buffer.from("not-a-webm"))).toBeNull();
    expect(parseSize(Buffer.alloc(0))).toBeNull();
  });

  it("reads the same dimensions from disk and tolerates a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-webm-"));
    const file = join(dir, "idle.webm");
    writeFileSync(file, buildWebm(640, 360));
    expect(readWebmSize(file)).toEqual({ width: 640, height: 360 });
    expect(readWebmSize(join(dir, "missing.webm"))).toBeNull();
  });
});
