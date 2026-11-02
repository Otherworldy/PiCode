import { execFile } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isRemoteWorkspaceIdentity } from "../remote-workspace-identity.js";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";
import { updateJsonConfigFile } from "./userCliConfigFile.js";
import {
  migrateLegacyWorkspaceConfig,
  readWorkspaceConfigText,
  resolveWorkspaceConfigPath,
} from "./workspaceConfig.js";

const execFileAsync = promisify(execFile);

/** Pi 项目目录名。与 Pi SDK 的 CONFIG_DIR_NAME 默认值保持一致。 */
export const PI_PROJECT_DIR_NAME = ".pi";
export const WORKSPACE_MEMORY_DIR_NAME = "memory";
export const WORKSPACE_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
export const WORKSPACE_MEMORY_ITEM_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/;
export const WORKSPACE_MEMORY_MAX_ITEM_BYTES = 64 * 1024;
/** 索引写入上限（UI 编辑与抽取落盘共用）。 */
export const WORKSPACE_MEMORY_MAX_INDEX_BYTES = 32 * 1024;
/**
 * 索引注入预算。超过后截断并附 WARNING 提示模型压缩；
 * 不再像以前那样整份丢弃，否则模型会以为记忆不存在。
 */
export const WORKSPACE_MEMORY_INDEX_MAX_LINES = 200;
export const WORKSPACE_MEMORY_INDEX_MAX_CHARS = 25_000;
/** 索引读取上限：只防超大文件卡住注入，与上面的注入预算无关。 */
export const WORKSPACE_MEMORY_INDEX_READ_MAX_BYTES = 1024 * 1024;

/** Windows 设备名不能作为文件名；抽取模型可能刚好生成 con.md。 */
const WINDOWS_RESERVED_FILE_STEMS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** 记忆文件所在目录：`<workspace>/.pi/memory`。 */
export function resolveWorkspaceMemoryRoot(workspacePath: string): string {
  return join(resolve(workspacePath), PI_PROJECT_DIR_NAME, WORKSPACE_MEMORY_DIR_NAME);
}

export function isWorkspaceMemoryItemFileName(fileName: string): boolean {
  if (fileName === WORKSPACE_MEMORY_INDEX_FILE_NAME) return false;
  if (!WORKSPACE_MEMORY_ITEM_FILE_PATTERN.test(fileName)) return false;
  const stem = fileName.slice(0, -".md".length);
  return !WINDOWS_RESERVED_FILE_STEMS.has(stem.toLowerCase());
}

export function isWorkspaceMemoryFileName(fileName: string): boolean {
  return fileName === WORKSPACE_MEMORY_INDEX_FILE_NAME || isWorkspaceMemoryItemFileName(fileName);
}

/** 远端工作区不在本机项目目录里读写记忆。 */
export function isWorkspaceMemorySupported(workspaceIdentity: string | undefined): boolean {
  const identity = workspaceIdentity?.trim();
  return !identity || !isRemoteWorkspaceIdentity(identity);
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 记忆根目录必须是普通目录，且路径本身不经过 symlink。
 * 仓库可以提交 `.pi/memory` 链接；不校验的话注入和抽取会读写到项目外。
 */
export async function assertWorkspaceMemoryRootTrusted(memoryRoot: string): Promise<void> {
  const metadata = await lstat(memoryRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Workspace memory root is not a regular directory: ${memoryRoot}`);
  }
  if (normalizePathForCompare(await realpath(memoryRoot)) !== normalizePathForCompare(memoryRoot)) {
    throw new Error(`Workspace memory root is outside the project: ${memoryRoot}`);
  }
}

/**
 * 读取 `<workspace>/.pi/picode.json` 的记忆开关（旧 `zcode.json` 会惰性迁移过来）。
 *
 * 记忆默认关闭：只有显式 `features.memory: true`（或旧格式 `memory.use: true`）
 * 才开启。文件缺失、JSON 损坏或字段不完整都按关闭处理，避免升级后悄悄开始
 * 往用户项目里写记忆。权限/IO 错误向上抛，由调用方决定是关记忆还是显示错误。
 */
export async function readWorkspaceMemoryEnabled(workspacePath: string): Promise<boolean> {
  const raw = await readWorkspaceConfigText(workspacePath);
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const features = parsed.features;
  if (isRecord(features) && typeof features.memory === "boolean") return features.memory;
  const memory = parsed.memory;
  if (isRecord(memory) && typeof memory.use === "boolean") return memory.use;
  return false;
}

/**
 * 写入项目记忆开关。只改 `features.memory`，保留项目配置里的其它键。
 * 与其它 workspace 级配置共用 `updateJsonConfigFile` 的锁与原子写。
 */
export async function setWorkspaceMemoryEnabled(
  workspacePath: string,
  enabled: boolean,
): Promise<void> {
  await migrateLegacyWorkspaceConfig(workspacePath);
  const configPath = resolveWorkspaceConfigPath(workspacePath);
  await updateJsonConfigFile(configPath, (current) => {
    const features = isRecord(current.features) ? current.features : {};
    if (features.memory === enabled) return null;
    return { ...current, features: { ...features, memory: enabled } };
  });
}

/**
 * 项目记忆抽取模型。缺省时跟随当前会话模型。
 *
 * 单独抽出来是因为这个模型只在 turn 结束后调用一次，通常选同 provider 的便宜模型。
 */
export interface WorkspaceMemoryModelConfig {
  providerId: string;
  modelId: string;
}

/**
 * 读取 `<workspace>/.pi/picode.json` 的记忆抽取模型。
 * 缺失、字段不完整或 JSON 损坏都返回 null，由调用方回退会话模型。
 */
export async function readWorkspaceMemoryModel(
  workspacePath: string,
): Promise<WorkspaceMemoryModelConfig | null> {
  const raw = await readWorkspaceConfigText(workspacePath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const features = parsed.features;
  if (!isRecord(features)) return null;
  const model = features.memoryModel;
  if (!isRecord(model)) return null;
  const providerId = typeof model.provider === "string" ? model.provider.trim() : "";
  const modelId = typeof model.model === "string" ? model.model.trim() : "";
  return providerId && modelId ? { providerId, modelId } : null;
}

/** 写入项目记忆抽取模型； `null` 删除配置，表示跟随会话模型。 */
export async function setWorkspaceMemoryModel(
  workspacePath: string,
  model: WorkspaceMemoryModelConfig | null,
): Promise<void> {
  await migrateLegacyWorkspaceConfig(workspacePath);
  const configPath = resolveWorkspaceConfigPath(workspacePath);
  await updateJsonConfigFile(configPath, (current) => {
    const features = isRecord(current.features) ? { ...current.features } : {};
    const currentModel = isRecord(features.memoryModel) ? features.memoryModel : null;
    const currentProvider =
      typeof currentModel?.provider === "string" ? currentModel.provider.trim() : "";
    const currentModelId = typeof currentModel?.model === "string" ? currentModel.model.trim() : "";
    if (!model) {
      if (!("memoryModel" in features)) return null;
      delete features.memoryModel;
      return { ...current, features };
    }
    if (currentProvider === model.providerId && currentModelId === model.modelId) return null;
    return {
      ...current,
      features: {
        ...features,
        memoryModel: { provider: model.providerId, model: model.modelId },
      },
    };
  });
}

/**
 * 首次创建记忆目录时把 `.pi/memory/` 加进仓库本地的 `.git/info/exclude`。
 * 不修改 `.gitignore`，失败静默：忽略配置只是隐私保护，不能阻塞记忆本身。
 */
export async function ensureWorkspaceMemoryGitExcluded(workspacePath: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: resolve(workspacePath),
      timeout: 5000,
      windowsHide: true,
    });
    const excludePath = resolve(workspacePath, stdout.trim());
    const entry = `${PI_PROJECT_DIR_NAME}/${WORKSPACE_MEMORY_DIR_NAME}/`;
    await withFileLock(excludePath, async () => {
      let current = "";
      try {
        current = await readFile(excludePath, "utf-8");
      } catch {
        current = "";
      }
      const lines = current.split(/\r?\n/u);
      if (lines.some((line) => line.trim() === entry)) return;
      const next = `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${entry}\n`;
      await atomicWritePrivateTextFile(excludePath, next);
    });
  } catch {
    // 非 git 仓库、没有 git 命令、或 exclude 不可写：记忆功能继续工作。
  }
}

/** 创建记忆目录（含 `.pi`）；首次创建时把目录加入仓库本地 exclude。 */
export async function ensureWorkspaceMemoryRoot(workspacePath: string): Promise<string> {
  const memoryRoot = resolveWorkspaceMemoryRoot(workspacePath);
  const existed = await access(memoryRoot).then(
    () => true,
    () => false,
  );
  await mkdir(memoryRoot, { recursive: true });
  await assertWorkspaceMemoryRootTrusted(memoryRoot);
  if (!existed) await ensureWorkspaceMemoryGitExcluded(workspacePath);
  return memoryRoot;
}

/** 判断 Write/Edit 的目标是否是可自动放行的记忆 Markdown。 */
export async function isWorkspaceMemoryMarkdownTarget(
  workspacePath: string,
  filePath: string,
): Promise<boolean> {
  const root = resolveWorkspaceMemoryRoot(workspacePath);
  const target = resolve(workspacePath, filePath);
  if (normalizePathForCompare(dirname(target)) !== normalizePathForCompare(root)) return false;
  if (!isWorkspaceMemoryFileName(basename(target))) return false;
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    const targetMetadata = await lstat(target).catch(() => null);
    if (targetMetadata && (!targetMetadata.isFile() || targetMetadata.isSymbolicLink())) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
