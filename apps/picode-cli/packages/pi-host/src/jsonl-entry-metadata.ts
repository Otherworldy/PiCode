import { createHash, type Hash } from "node:crypto";
import { clipJsonlText } from "./jsonl-history.js";

export type EntryMetadata = { type?: string; id?: string; parentId?: string; title?: string };
type Frame = { object: boolean; state: string; key?: string };

/** 只留下标题和父链；大消息的字符串、数组和对象逐字校验，不积累单行正文。 */
export class JsonlEntryMetadata {
  private readonly frames: Frame[] = [];
  private readonly metadata: EntryMetadata = {};
  private invalid = false;
  private done = false;
  private mode: "string" | "primitive" | undefined;
  private keyToken = false;
  private field: string | undefined;
  private text = "";
  private hash: Hash | undefined;
  private escaped = false;
  private unicode: string | undefined;
  private primitive = "";
  private numberState = "";
  private whitespace = false;
  private internalWhitespace = false;
  private stringLength = 0;
  private firstSlash = false;

  write(chunk: string): void {
    for (let index = 0; index < chunk.length && !this.invalid; index += 1) {
      const char = chunk[index]!;
      if (this.mode === "string") {
        this.stringChar(char);
        continue;
      }
      if (this.mode === "primitive") {
        if (!/[\s,}\]]/u.test(char)) {
          this.primitiveChar(char);
          continue;
        }
        this.endPrimitive();
      }
      if (/^[\x20\t\r\n]$/u.test(char)) continue;
      const frame = this.frames.at(-1);
      if (this.done) {
        this.invalid = true;
        continue;
      }
      if (frame?.object && (frame.state === "key" || frame.state === "first")) {
        if (char === "}" && frame.state === "first") this.endContainer();
        else if (char === '"') this.startString(true);
        else this.invalid = true;
      } else if (frame?.state === "colon") {
        if (char === ":") frame.state = "value";
        else this.invalid = true;
      } else if (frame?.state === "after") {
        if (char === ",") frame.state = frame.object ? "key" : "value";
        else if (char === (frame.object ? "}" : "]")) this.endContainer();
        else this.invalid = true;
      } else if (char === "]" && frame && !frame.object && frame.state === "first") {
        this.endContainer();
      } else if (char === "{" || char === "[") {
        if (!frame && char !== "{") this.invalid = true;
        this.clearField();
        this.frames.push({ object: char === "{", state: "first" });
      } else if (char === '"' && frame) {
        this.startString(false);
      } else if (frame && /[-0-9tfn]/u.test(char)) {
        this.mode = "primitive";
        this.primitive = "";
        this.numberState = "";
        this.primitiveChar(char);
      } else this.invalid = true;
    }
  }

  finish(): EntryMetadata | null {
    if (this.mode === "primitive") this.endPrimitive();
    if (this.metadata.type !== "session_info") delete this.metadata.title;
    return !this.invalid && this.done && !this.mode ? this.metadata : null;
  }

  private acceptValue(): void {
    const frame = this.frames.at(-1);
    if (frame) frame.state = "after";
    else this.done = true;
  }

  private endContainer(): void {
    this.frames.pop();
    this.acceptValue();
  }

  private startString(key: boolean): void {
    this.mode = "string";
    this.keyToken = key;
    this.field = this.frames.length === 1 ? this.frames[0]?.key : undefined;
    this.text = "";
    this.stringLength = 0;
    this.whitespace = false;
    this.internalWhitespace = false;
    this.firstSlash = false;
    this.escaped = false;
    this.unicode = undefined;
    this.hash =
      !key && (this.field === "id" || this.field === "parentId") ? createHash("sha256") : undefined;
  }

  private decoded(char: string): void {
    if (this.keyToken || this.field === "type") {
      if (this.text.length < 32) this.text += char;
    } else if (this.hash) {
      this.stringLength += char.length;
      // 按 UTF-16 编码散列，转义与直接写入的 id 等价，超长 id 也不占用行缓冲。
      this.hash.update(Buffer.from(char, "utf16le"));
    } else if (this.field === "name") {
      if (/\s/u.test(char)) {
        if (this.stringLength > 0) this.whitespace = true;
      } else {
        if (this.stringLength === 0) this.firstSlash = char === "/";
        if (this.whitespace) {
          this.internalWhitespace = true;
          if (this.text.length < 62) this.text += " ";
        }
        this.whitespace = false;
        this.stringLength += 1;
        if (this.text.length < 62) this.text += char;
      }
    }
  }

  private stringChar(char: string): void {
    if (this.unicode !== undefined) {
      if (!/[0-9a-f]/iu.test(char)) {
        this.invalid = true;
        return;
      }
      this.unicode += char;
      if (this.unicode.length === 4) {
        this.decoded(String.fromCharCode(Number.parseInt(this.unicode, 16)));
        this.unicode = undefined;
      }
    } else if (this.escaped) {
      this.escaped = false;
      if (char === "u") this.unicode = "";
      else {
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        const decoded = escapes[char];
        if (decoded === undefined) this.invalid = true;
        else this.decoded(decoded);
      }
    } else if (char === "\\") this.escaped = true;
    else if (char === '"') {
      this.mode = undefined;
      const frame = this.frames.at(-1)!;
      if (this.keyToken) {
        frame.key = this.frames.length === 1 ? this.text : undefined;
        frame.state = "colon";
      } else {
        if (this.field === "type") this.metadata.type = this.text;
        else if (this.field === "id" || this.field === "parentId") {
          this.metadata[this.field] = this.stringLength ? this.hash!.digest("hex") : "";
        } else if (this.field === "name") {
          const command = this.firstSlash && this.stringLength > 1 && !this.internalWhitespace;
          this.metadata.title =
            this.stringLength && !command ? clipJsonlText(this.text, 60) : undefined;
        }
        this.acceptValue();
      }
    } else if (char.charCodeAt(0) < 32) this.invalid = true;
    else this.decoded(char);
  }

  private primitiveChar(char: string): void {
    if (!this.primitive && !this.numberState && /[tfn]/u.test(char)) this.primitive = char;
    else if (this.primitive) {
      this.primitive += char;
      if (!["true", "false", "null"].some((value) => value.startsWith(this.primitive)))
        this.invalid = true;
    } else {
      const digit = /[0-9]/u.test(char);
      const next: Record<string, string> = {
        "": char === "-" ? "sign" : char === "0" ? "zero" : /[1-9]/u.test(char) ? "int" : "",
        sign: char === "0" ? "zero" : /[1-9]/u.test(char) ? "int" : "",
        zero: char === "." ? "dot" : /[eE]/u.test(char) ? "exp" : "",
        int: digit ? "int" : char === "." ? "dot" : /[eE]/u.test(char) ? "exp" : "",
        dot: digit ? "fraction" : "",
        fraction: digit ? "fraction" : /[eE]/u.test(char) ? "exp" : "",
        exp: /[+-]/u.test(char) ? "expSign" : digit ? "expDigits" : "",
        expSign: digit ? "expDigits" : "",
        expDigits: digit ? "expDigits" : "",
      };
      this.numberState = next[this.numberState] ?? "";
      if (!this.numberState) this.invalid = true;
    }
  }

  private endPrimitive(): void {
    if (
      this.primitive
        ? !["true", "false", "null"].includes(this.primitive)
        : !["zero", "int", "fraction", "expDigits"].includes(this.numberState)
    )
      this.invalid = true;
    this.clearField();
    this.mode = undefined;
    this.acceptValue();
  }

  private clearField(): void {
    if (this.frames.length !== 1) return;
    const key = this.frames[0]?.key;
    if (key === "type" || key === "id" || key === "parentId") delete this.metadata[key];
    if (key === "name") delete this.metadata.title;
  }
}
