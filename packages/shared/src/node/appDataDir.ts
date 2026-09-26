import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/** 用户数据目录名。旧目录 `.zcode` 在第一次解析时整目录改名过来。 */
export const APP_DATA_DIR_NAME = ".PiCode";
export const LEGACY_APP_DATA_DIR_NAME = ".zcode";

export function isAppDataDirName(name: string): boolean {
  return name === APP_DATA_DIR_NAME || name === LEGACY_APP_DATA_DIR_NAME;
}

/**
 * 返回 `parent/.PiCode`。新目录还不存在、旧 `.zcode` 存在时改名。
 * 改名失败（目录被占用）则继续用旧目录，避免写成两套数据。
 */
export function ensureAppDataDir(parent: string): string {
  const next = join(parent, APP_DATA_DIR_NAME);
  const legacy = join(parent, LEGACY_APP_DATA_DIR_NAME);
  try {
    if (!existsSync(next) && existsSync(legacy)) {
      renameSync(legacy, next);
    }
  } catch {
    if (!existsSync(next) && existsSync(legacy)) return legacy;
  }
  return next;
}
