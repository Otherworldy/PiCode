import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { dirname, join, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import { findPetPackDir } from "./pack.js";
import type { DesktopPetDownloadFailure } from "@zcode/shared";

const MAX_PACK_BYTES = 512 * 1024 * 1024;

export class PetPackDownloadError extends Error {
  readonly reason: DesktopPetDownloadFailure;
  readonly status?: number;

  constructor(reason: DesktopPetDownloadFailure, status?: number) {
    super(reason);
    this.name = "PetPackDownloadError";
    this.reason = reason;
    this.status = status;
  }
}

export type PetPackDownloadProgress =
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "extracting" };

export async function downloadPetPack(
  url: string,
  packsDir: string,
  options?: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    onProgress?: (event: PetPackDownloadProgress) => void;
  },
): Promise<string> {
  const parsed = parsePackUrl(url);
  const hash = createHash("sha256").update(parsed.href).digest("hex").slice(0, 16);
  const dest = join(packsDir, hash);
  const marker = join(dest, ".source-url");
  if (existsSync(marker) && readFileSync(marker, "utf8") === parsed.href && findPetPackDir(dest)) {
    return dest;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const zipPath = join(dest, "pack.zip");
  try {
    await writeResponseBody(parsed.href, zipPath, options);
    if (options?.signal?.aborted) throw aborted();
    options?.onProgress?.({ phase: "extracting" });
    await extractZip(zipPath, dest, options?.signal);
    rmSync(zipPath, { force: true });
    if (!findPetPackDir(dest)) throw new PetPackDownloadError("missing-config");
    writeFileSync(marker, parsed.href);
    return dest;
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    if (options?.signal?.aborted) throw error;
    if (error instanceof PetPackDownloadError) throw error;
    throw new PetPackDownloadError("missing-config");
  }
}

function parsePackUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PetPackDownloadError("invalid-url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PetPackDownloadError("invalid-url");
  }
  return parsed;
}

function aborted(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

async function writeResponseBody(
  url: string,
  zipPath: string,
  options?: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    onProgress?: (event: PetPackDownloadProgress) => void;
  },
): Promise<void> {
  let response: Response;
  try {
    response = await (options?.fetch ?? fetch)(url, { signal: options?.signal });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new PetPackDownloadError("network");
  }
  if (!response.ok || !response.body) {
    throw new PetPackDownloadError("http", response.status);
  }
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  if (total != null && total > MAX_PACK_BYTES) throw new PetPackDownloadError("too-large");
  const output = createWriteStream(zipPath);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_PACK_BYTES) throw new PetPackDownloadError("too-large");
      options?.onProgress?.({ phase: "downloading", received, total });
      if (!output.write(chunk.value)) await once(output, "drain");
    }
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (error instanceof PetPackDownloadError) throw error;
    throw new PetPackDownloadError("network");
  } finally {
    output.end();
    await finished(output).catch(() => {
      // 失败时关掉文件再删目录，避免 Windows 上还占着 pack.zip。
    });
  }
}

async function extractZip(zipPath: string, dest: string, signal?: AbortSignal): Promise<void> {
  const zip = await openZipFile(zipPath);
  let uncompressed = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error instanceof Error ? error : new Error("failed to extract pet pack"));
    };
    const onAbort = () => fail(aborted());
    signal?.addEventListener("abort", onAbort);
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      if (signal?.aborted) {
        fail(aborted());
        return;
      }
      if (entry.fileName.endsWith("/")) {
        zip.readEntry();
        return;
      }
      const target = safeZipPath(dest, entry.fileName);
      if (!target) {
        fail(new PetPackDownloadError("missing-config"));
        return;
      }
      uncompressed += entry.uncompressedSize;
      if (uncompressed > MAX_PACK_BYTES) {
        fail(new PetPackDownloadError("too-large"));
        return;
      }
      mkdirSync(dirname(target), { recursive: true });
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error("failed to read pet pack entry"));
          return;
        }
        const output = createWriteStream(target);
        stream.pipe(output);
        output.on("finish", () => zip.readEntry());
        output.on("error", fail);
        stream.on("error", fail);
      });
    });
    zip.on("end", finish);
    if (signal?.aborted) {
      fail(aborted());
      return;
    }
    zip.readEntry();
  });
}

function openZipFile(zipPath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    openZip(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("failed to open pet pack"));
      else resolvePromise(zip);
    });
  });
}

function safeZipPath(root: string, entryName: string): string | null {
  if (entryName.includes("\0")) return null;
  const target = resolve(root, entryName);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}
