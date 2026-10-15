import { open } from "node:fs/promises";

/** 首行 session header 通常远小于这个值。读满仍没有换行就当成没看清，交给全文读取。 */
const SESSION_HEADER_PROBE_BYTES = 8192;

export type SessionHeaderProbe =
  | { status: "id"; id: string }
  | { status: "miss" }
  | { status: "unknown" };

/** 文件名就是会话 id，或 Pi 的 `时间戳_会话id.jsonl`。 */
export function sessionFileNameMatches(fileName: string, sessionId: string): boolean {
  if (!sessionId || !fileName.endsWith(".jsonl")) return false;
  const stem = fileName.slice(0, -".jsonl".length);
  return stem === sessionId || stem.endsWith(`_${sessionId}`);
}

/** 只解析开头这一段。首行不是 session header 则 miss；首行被截断则 unknown。 */
export function probeSessionHeaderPrefix(prefix: string, truncated: boolean): SessionHeaderProbe {
  const newline = prefix.indexOf("\n");
  if (newline === -1 && truncated) return { status: "unknown" };
  const line = (newline === -1 ? prefix : prefix.slice(0, newline)).trim();
  if (!line) return { status: "miss" };
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "miss" };
    const record = parsed as Record<string, unknown>;
    if (record.type !== "session" || typeof record.id !== "string" || record.id.length === 0) {
      return { status: "miss" };
    }
    return { status: "id", id: record.id };
  } catch {
    return newline === -1 ? { status: "unknown" } : { status: "miss" };
  }
}

/** 打开定位只看首行 id。看不清时返回 unknown，调用方再读全文。 */
export async function readSessionHeaderId(sessionFile: string): Promise<SessionHeaderProbe> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sessionFile, "r");
    const buffer = Buffer.alloc(SESSION_HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    return probeSessionHeaderPrefix(prefix, bytesRead === buffer.length);
  } catch {
    return { status: "miss" };
  } finally {
    await handle?.close();
  }
}
