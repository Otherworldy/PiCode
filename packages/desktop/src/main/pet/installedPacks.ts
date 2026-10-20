import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DesktopPetInstalledPack } from "@zcode/shared";
import { loadPetPack } from "./pack.js";

/** 生成本地导入目录的唯一标识。 */
export function localPackId(dir: string): string {
  const hash = createHash("sha256").update(dir.trim().toLowerCase()).digest("hex").slice(0, 16);
  return `local_${hash}`;
}

/** 扫描下载缓存与已导入的本地宠物。打不开或损坏的目录自动忽略。 */
export function listInstalledPetPacks(petRootDir: string): DesktopPetInstalledPack[] {
  const packsDir = existsSync(join(petRootDir, "packs")) ? join(petRootDir, "packs") : petRootDir;
  const packs: DesktopPetInstalledPack[] = [];

  // 1. 扫描在线下载的解压缓存包
  let entries: string[] = [];
  try {
    entries = readdirSync(packsDir);
  } catch {
    entries = [];
  }
  for (const id of entries) {
    const dir = join(packsDir, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const url = readSourceUrl(dir);
    if (!url) continue;
    const pack = loadPetPack(dir);
    if (!pack) continue;
    const idleClipPath = pack.idle[0]?.filePath ?? pack.categories[0]?.actions[0]?.filePath;
    packs.push({
      id,
      name: pack.name || labelFromUrl(url),
      sourceType: "download",
      url,
      size: pack.size,
      idleClipPath,
    });
  }

  // 2. 扫描本地导入的有效目录
  const importedDirs = readImportedDirs(petRootDir);
  for (const localPath of importedDirs) {
    if (!existsSync(localPath)) continue;
    const pack = loadPetPack(localPath);
    if (!pack) continue;
    const idleClipPath = pack.idle[0]?.filePath ?? pack.categories[0]?.actions[0]?.filePath;
    packs.push({
      id: localPackId(localPath),
      name: pack.name || basename(localPath) || "本地宠物",
      sourceType: "local",
      localPath,
      size: pack.size,
      idleClipPath,
    });
  }

  packs.sort(
    (left, right) =>
      left.name.localeCompare(right.name, "zh") ||
      (left.url ?? left.localPath ?? "").localeCompare(right.url ?? right.localPath ?? ""),
  );
  return packs;
}

/** 导入本地宠物目录，校验有效后写入 imported.json。 */
export function importLocalPetPack(
  petRootDir: string,
  localDir: string,
): { success: boolean; error?: string; pack?: DesktopPetInstalledPack } {
  const trimmed = localDir.trim();
  if (!trimmed || !existsSync(trimmed)) {
    return { success: false, error: "not-found" };
  }
  const pack = loadPetPack(trimmed);
  if (!pack) {
    return { success: false, error: "invalid-pack" };
  }
  const current = readImportedDirs(petRootDir);
  if (!current.some((d) => d.toLowerCase() === trimmed.toLowerCase())) {
    current.push(trimmed);
    writeImportedDirs(petRootDir, current);
  }
  const idleClipPath = pack.idle[0]?.filePath ?? pack.categories[0]?.actions[0]?.filePath;
  return {
    success: true,
    pack: {
      id: localPackId(trimmed),
      name: pack.name || basename(trimmed) || "本地宠物",
      sourceType: "local",
      localPath: trimmed,
      size: pack.size,
      idleClipPath,
    },
  };
}

/** 删除宠物：本地导入仅移除链接记录；在线下载则彻底删除 packs/ 缓存目录。 */
export function deleteInstalledPetPack(
  petRootDir: string,
  id: string,
  sourceType: "download" | "local",
): boolean {
  if (sourceType === "local") {
    const current = readImportedDirs(petRootDir);
    const next = current.filter((dir) => localPackId(dir) !== id && dir !== id);
    if (next.length !== current.length) {
      writeImportedDirs(petRootDir, next);
      return true;
    }
    return false;
  }

  const packsDir = existsSync(join(petRootDir, "packs")) ? join(petRootDir, "packs") : petRootDir;
  const targetDir = join(packsDir, id);
  try {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function readImportedDirs(petRootDir: string): string[] {
  const file = join(petRootDir, "imported.json");
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
    }
  } catch {
    // 忽略丢失或非法的 JSON
  }
  return [];
}

function writeImportedDirs(petRootDir: string, dirs: string[]): void {
  const file = join(petRootDir, "imported.json");
  try {
    writeFileSync(file, JSON.stringify(dirs, null, 2), "utf8");
  } catch {
    // 写入失败忽略
  }
}

function readSourceUrl(dir: string): string | null {
  try {
    const url = readFileSync(join(dir, ".source-url"), "utf8").trim();
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function labelFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name) return decodeURIComponent(name);
  } catch {
    // 地址解析失败时直接显示原文。
  }
  return url;
}
