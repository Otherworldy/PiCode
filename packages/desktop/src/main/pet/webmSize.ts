import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * dsh 包里的片段是 640×360 这类 16:9 画面，宠物的 `size` 只约定宽度。
 * 窗口按正方形留位会多出一大截透明区域，所以加载包时读一次视频像素尺寸。
 */
const READ_LIMIT_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const MASTER_IDS = new Set([
  0x18538067, // Segment
  0x114d9b74, // SeekHead
  0x4dbb, // Seek
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xe0, // Video
  0xe1, // Audio
  0x1f43b675, // Cluster
  0xa0, // BlockGroup
]);

export function readWebmSize(path: string): { width: number; height: number } | null {
  let buffer: Buffer;
  try {
    const total = statSync(path).size;
    if (total <= 0) return null;
    const length = Math.min(total, READ_LIMIT_BYTES);
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(length);
      const read = readSync(fd, chunk, 0, length, 0);
      if (read <= 0) return null;
      buffer = chunk.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  return parseSize(buffer);
}

export function parseSize(buffer: Buffer): { width: number; height: number } | null {
  const found = { width: 0, height: 0 };
  walk(buffer, 0, buffer.length, 0, found);
  if (found.width <= 0 || found.height <= 0) return null;
  return { width: found.width, height: found.height };
}

function walk(
  buffer: Buffer,
  start: number,
  end: number,
  depth: number,
  found: { width: number; height: number },
): boolean {
  let pos = start;
  while (pos < end - 1) {
    const id = readVint(buffer, pos, true);
    if (!id) return false;
    const size = readVint(buffer, pos + id.length, false);
    if (!size) return false;
    const dataStart = pos + id.length + size.length;
    const unknownSize = size.length > 1 && size.value === 2 ** (7 * size.length) - 1;
    const dataEnd = unknownSize ? end : Math.min(end, dataStart + size.value);
    if (dataEnd < dataStart || dataStart > end) return false;
    if (id.value === ID_PIXEL_WIDTH) found.width = readUint(buffer, dataStart, dataEnd);
    else if (id.value === ID_PIXEL_HEIGHT) found.height = readUint(buffer, dataStart, dataEnd);
    else if (depth < MAX_DEPTH && MASTER_IDS.has(id.value)) {
      if (walk(buffer, dataStart, dataEnd, depth + 1, found)) return true;
    }
    if (found.width > 0 && found.height > 0) return true;
    pos = dataEnd;
  }
  return false;
}

function readVint(
  buffer: Buffer,
  pos: number,
  keepMarker: boolean,
): { value: number; length: number } | null {
  const first = buffer[pos];
  if (first === undefined || first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
    if (length > 8) return null;
  }
  let value = keepMarker ? first : first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    const byte = buffer[pos + index];
    if (byte === undefined) return null;
    value = value * 256 + byte;
  }
  return { value, length };
}

function readUint(buffer: Buffer, start: number, end: number): number {
  let value = 0;
  for (let index = start; index < end; index += 1) value = value * 256 + (buffer[index] ?? 0);
  return value;
}
