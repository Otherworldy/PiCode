export const PET_READER_PAGE_CHARS = 4_000;
export const PET_READER_CHUNK_BYTES = 64 * 1024;
export const PET_READER_MAX_BYTES = 512 * 1024 * 1024;

export type PetReaderEncoding = "utf-8" | "gb18030";

/** UTF-8（含 BOM）优先，否则按国标解码。只看文件开头，不读全文。 */
export function detectPetReaderEncoding(bytes: Uint8Array): PetReaderEncoding {
  const sample = bytes.subarray(0, PET_READER_CHUNK_BYTES);
  const body =
    sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf
      ? sample.subarray(3)
      : sample;
  // 采样长度是固定的，正好切在多字节字符中间时尾部会残缺，不先对齐就会把 UTF-8 判成国标。
  return isUtf8(body.subarray(0, prefixBytes(body, "utf-8", Number.MAX_SAFE_INTEGER)))
    ? "utf-8"
    : "gb18030";
}

/** 从缓冲开头截出至多 maxChars 个完整字符。 */
export function readPetReaderChars(
  bytes: Uint8Array,
  encoding: PetReaderEncoding,
  maxChars: number,
): { text: string; byteLength: number } {
  const byteLength = prefixBytes(bytes, encoding, maxChars);
  const text = new TextDecoder(encoding).decode(bytes.subarray(0, byteLength));
  return { text, byteLength };
}

/** 取缓冲末尾至多 maxChars 个字符，并给出它在缓冲里的起点。开头如果切在半个字上会先对齐。 */
export function readPetReaderTail(
  bytes: Uint8Array,
  encoding: PetReaderEncoding,
  maxChars: number,
): { text: string; start: number } {
  const aligned = alignReaderStart(bytes, encoding);
  const body = bytes.subarray(aligned);
  const marks = charStarts(body, encoding);
  const charCount = marks.length - 1;
  const from = Math.max(0, charCount - maxChars);
  const start = marks[from] ?? 0;
  const text = new TextDecoder(encoding).decode(body.subarray(start));
  return { text, start: aligned + start };
}

/** 在这一段里查找。找不到返回 -1。返回的是相对 bytes 起点的字节偏移。 */
export function findPetReaderQuery(
  bytes: Uint8Array,
  encoding: PetReaderEncoding,
  query: string,
): number {
  if (!query) return -1;
  const aligned = alignReaderStart(bytes, encoding);
  const body = bytes.subarray(aligned);
  const complete = prefixBytes(body, encoding, Number.MAX_SAFE_INTEGER);
  const text = new TextDecoder(encoding).decode(body.subarray(0, complete));
  const index = text.indexOf(query);
  if (index < 0) return -1;
  const byteLength =
    encoding === "utf-8"
      ? new TextEncoder().encode(text.slice(0, index)).length
      : prefixBytes(body, encoding, index);
  return aligned + byteLength;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const encoded = new TextEncoder().encode(decoded);
    if (encoded.length !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i += 1) {
      if (encoded[i] !== bytes[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function prefixBytes(bytes: Uint8Array, encoding: PetReaderEncoding, maxChars: number): number {
  let index = 0;
  let chars = 0;
  while (index < bytes.length && chars < maxChars) {
    const size = encoding === "utf-8" ? utf8CharLength(bytes, index) : gbCharLength(bytes, index);
    if (size <= 0) break;
    index += size;
    chars += 1;
  }
  return index;
}

function charStarts(bytes: Uint8Array, encoding: PetReaderEncoding): number[] {
  const marks = [0];
  let index = 0;
  while (index < bytes.length) {
    const size = encoding === "utf-8" ? utf8CharLength(bytes, index) : gbCharLength(bytes, index);
    if (size <= 0) break;
    index += size;
    marks.push(index);
  }
  return marks;
}

function alignReaderStart(bytes: Uint8Array, encoding: PetReaderEncoding): number {
  if (encoding === "utf-8") {
    let index = 0;
    while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index += 1;
    return index;
  }
  for (let start = 0; start < 4 && start < bytes.length; start += 1) {
    if (
      prefixBytes(bytes.subarray(start), encoding, Number.MAX_SAFE_INTEGER) ===
      bytes.length - start
    ) {
      return start;
    }
  }
  return 0;
}

function utf8CharLength(bytes: Uint8Array, index: number): number {
  const available = bytes.length - index;
  if (available <= 0) return 0;
  const lead = bytes[index]!;
  let need = 1;
  if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else if ((lead & 0x80) !== 0) return 1;
  return available < need ? 0 : need;
}

function gbCharLength(bytes: Uint8Array, index: number): number {
  const available = bytes.length - index;
  if (available <= 0) return 0;
  const lead = bytes[index]!;
  if (lead <= 0x7f) return 1;
  if (lead < 0x81 || lead > 0xfe) return 1;
  if (available < 2) return 0;
  const second = bytes[index + 1]!;
  if (second >= 0x30 && second <= 0x39) {
    if (available < 4) return 0;
    const third = bytes[index + 2]!;
    const fourth = bytes[index + 3]!;
    if (third >= 0x81 && third <= 0xfe && fourth >= 0x30 && fourth <= 0x39) return 4;
    return 1;
  }
  if ((second >= 0x40 && second <= 0x7e) || (second >= 0x80 && second <= 0xfe)) return 2;
  return 1;
}
