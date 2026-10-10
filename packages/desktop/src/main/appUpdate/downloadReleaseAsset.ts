import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class AppUpdateAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "AppUpdateAborted";
  }
}

export async function downloadReleaseAsset(options: {
  url: string;
  filePath: string;
  fallbackTotal?: number;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
}): Promise<void> {
  if (!options.url.startsWith("https://")) {
    throw new Error("unsupported update url");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      signal: options.signal,
      redirect: "follow",
      headers: { "User-Agent": "PiCode", Accept: "application/octet-stream" },
    });
  } catch (error) {
    if (isAbort(error)) throw new AppUpdateAborted();
    throw error;
  }
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status}`);
  }
  const headerTotal = Number(response.headers.get("content-length") ?? "0");
  const total =
    Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : (options.fallbackTotal ?? 0);
  let received = 0;
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  source.on("data", (chunk: Buffer | string) => {
    received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    options.onProgress(received, total);
  });
  try {
    await pipeline(source, createWriteStream(options.filePath), { signal: options.signal });
  } catch (error) {
    await unlink(options.filePath).catch(() => undefined);
    if (isAbort(error)) throw new AppUpdateAborted();
    throw error;
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "AppUpdateAborted")
  );
}
