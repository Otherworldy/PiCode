import { normalizeDesktopPetReaderHotkey } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  detectPetReaderEncoding,
  findPetReaderQuery,
  PET_READER_CHUNK_BYTES,
  readPetReaderChars,
  readPetReaderTail,
} from "./readerText.js";

describe("pet reader text", () => {
  it("reads a window of utf-8 or gbk without needing the rest of the file", () => {
    const utf8 = Buffer.from("你好世界");
    expect(detectPetReaderEncoding(utf8)).toBe("utf-8");
    expect(readPetReaderChars(utf8, "utf-8", 2)).toEqual({ text: "你好", byteLength: 6 });

    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd6, 0xd0, 0xce, 0xc4]);
    expect(detectPetReaderEncoding(gbk)).toBe("gb18030");
    expect(readPetReaderChars(gbk, "gb18030", 2)).toEqual({ text: "中文", byteLength: 4 });
    expect(readPetReaderTail(gbk, "gb18030", 2)).toEqual({ text: "中文", start: 4 });
  });

  it("finds a phrase and ignores a byte that starts mid-character", () => {
    const text = Buffer.from("abc小说");
    expect(findPetReaderQuery(text, "utf-8", "小说")).toBe(Buffer.from("abc").length);
    const torn = Buffer.concat([Buffer.from([0x80]), Buffer.from("abcd")]);
    expect(readPetReaderTail(torn, "utf-8", 2)).toEqual({ text: "cd", start: 3 });
  });

  it("keeps utf-8 when the sample is cut in the middle of a character", () => {
    const torn = Buffer.concat([
      Buffer.alloc(PET_READER_CHUNK_BYTES - 1, 0x41),
      Buffer.from("你").subarray(0, 1),
    ]);
    expect(torn.length).toBe(PET_READER_CHUNK_BYTES);
    expect(detectPetReaderEncoding(torn)).toBe("utf-8");

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), torn.subarray(1)]);
    expect(detectPetReaderEncoding(withBom)).toBe("utf-8");
  });

  it("normalizes the shortcut and rejects anything that is not a key", () => {
    expect(normalizeDesktopPetReaderHotkey(undefined)).toBe("F9");
    expect(normalizeDesktopPetReaderHotkey("f1")).toBe("F1");
    expect(normalizeDesktopPetReaderHotkey("ctrl+alt+f2")).toBe("CommandOrControl+Alt+F2");
    expect(normalizeDesktopPetReaderHotkey("hello")).toBe("F9");
  });
});
