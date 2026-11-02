import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * 项目级配置：`<workspace>/.pi/picode.json`。
 *
 * 早期版本把同一份配置放在项目根 `zcode.json`。这里在读取时把旧文件惰性复制到新路径，
 * 旧文件保留不动，避免用户升级后配置凭空失效。
 */
export const WORKSPACE_CONFIG_DIR_NAME = ".pi";
export const WORKSPACE_CONFIG_FILE_NAME = "picode.json";
export const LEGACY_WORKSPACE_CONFIG_FILE_NAME = "zcode.json";

export function resolveWorkspaceConfigPath(workspacePath: string): string {
  return join(resolve(workspacePath), WORKSPACE_CONFIG_DIR_NAME, WORKSPACE_CONFIG_FILE_NAME);
}

export function resolveLegacyWorkspaceConfigPath(workspacePath: string): string {
  return join(resolve(workspacePath), LEGACY_WORKSPACE_CONFIG_FILE_NAME);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writeConfigIfAbsent(filePath: string, text: string): Promise<boolean> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, text, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function writeConfigIfAbsentSync(filePath: string, text: string): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, text, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读项目配置原文：`.pi/picode.json` 优先，不存在时回退根目录 `zcode.json`，
 * 并顺带把旧内容复制到新路径。只有「文件不存在」返回 null，其它 IO 错误向上抛。
 */
export async function readWorkspaceConfigText(workspacePath: string): Promise<string | null> {
  try {
    return await readFile(resolveWorkspaceConfigPath(workspacePath), "utf-8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  let legacyText: string;
  try {
    legacyText = await readFile(resolveLegacyWorkspaceConfigPath(workspacePath), "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  await writeConfigIfAbsent(resolveWorkspaceConfigPath(workspacePath), legacyText);
  return legacyText;
}

/** 把根目录 `zcode.json` 复制到 `.pi/picode.json`；新文件已存在或旧文件缺失时不做任何事。 */
export async function migrateLegacyWorkspaceConfig(workspacePath: string): Promise<boolean> {
  const configPath = resolveWorkspaceConfigPath(workspacePath);
  try {
    await readFile(configPath, "utf-8");
    return false;
  } catch (error) {
    if (!isNotFoundError(error)) return false;
  }
  try {
    const legacyText = await readFile(resolveLegacyWorkspaceConfigPath(workspacePath), "utf-8");
    return await writeConfigIfAbsent(configPath, legacyText);
  } catch {
    return false;
  }
}

/** sync 版本给 workspace hook 的同步发现用。 */
export function migrateLegacyWorkspaceConfigSync(workspacePath: string): boolean {
  const configPath = resolveWorkspaceConfigPath(workspacePath);
  try {
    readFileSync(configPath, "utf-8");
    return false;
  } catch (error) {
    if (!isNotFoundError(error)) return false;
  }
  try {
    const legacyText = readFileSync(resolveLegacyWorkspaceConfigPath(workspacePath), "utf-8");
    return writeConfigIfAbsentSync(configPath, legacyText);
  } catch {
    return false;
  }
}
