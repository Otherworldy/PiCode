import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { JsonlEntryMetadata, type EntryMetadata } from "./jsonl-entry-metadata.js";

const SCAN_BYTES = 64 * 1024;

async function readAt(handle: FileHandle, buffer: Buffer, start: number, length: number) {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (!bytesRead) throw new Error("Session changed during title scan");
    filled += bytesRead;
  }
}

async function* entriesBackwards(handle: FileHandle, size: number): AsyncGenerator<EntryMetadata> {
  const scan = Buffer.alloc(SCAN_BYTES);
  const line = Buffer.alloc(SCAN_BYTES);
  const parse = async (start: number, end: number, blockStart: number, blockEnd: number) => {
    const parser = new JsonlEntryMetadata();
    const decoder = new StringDecoder("utf8");
    // 同块内的短行直接解析；跨块长行只留元数据与 JSON 语法栈，不拼接单行。
    if (start >= blockStart && end <= blockEnd) {
      parser.write(scan.toString("utf8", start - blockStart, end - blockStart));
    } else {
      for (let offset = start; offset < end; offset += SCAN_BYTES) {
        const length = Math.min(SCAN_BYTES, end - offset);
        await readAt(handle, line, offset, length);
        parser.write(decoder.write(line.subarray(0, length)));
      }
      parser.write(decoder.end());
    }
    return parser.finish();
  };
  let end = size;
  for (let position = size; position > 0; ) {
    const start = Math.max(0, position - SCAN_BYTES);
    await readAt(handle, scan, start, position - start);
    for (let index = position - start - 1; index >= 0; index -= 1) {
      if (scan[index] !== 10) continue;
      const entry = await parse(start + index + 1, end, start, position);
      if (entry) yield entry;
      end = start + index;
    }
    if (start === 0) {
      const entry = await parse(0, end, start, position);
      if (entry) yield entry;
    }
    position = start;
  }
}

/** null 表示当前分支没有有效名称；undefined 表示读失败，调用方沿用原有摘要容错。 */
export async function readStoredSessionTitle(path: string): Promise<string | null | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    let leaf = false;
    let emptyLeaf = false;
    let current: string | undefined;
    let linked = false;
    let latest: string | undefined;
    let branchTitle: string | undefined;
    for await (const entry of entriesBackwards(handle, size)) {
      if (entry.parentId) linked = true;
      if (entry.type === "session") continue;
      latest ??= entry.title;
      if (!leaf && entry.id !== undefined) {
        leaf = true;
        emptyLeaf = entry.id === "";
        current = entry.id;
      }
      if (entry.id !== undefined && current === entry.id) {
        branchTitle ??= entry.title;
        current = entry.parentId;
      }
      // Pi 的 id 唯一且父节点先于子节点落盘，反向扫描只需保存下一个父 id。
      // 原先只读文件头会漏掉总结后的 session_info，尾读固定窗口也会被后续大消息挡住。
      if (linked && leaf && !emptyLeaf && branchTitle !== undefined) return branchTitle;
    }
    return (linked && leaf && !emptyLeaf ? branchTitle : latest) ?? null;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
