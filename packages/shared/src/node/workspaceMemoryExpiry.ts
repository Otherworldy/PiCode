import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { updateJsonConfigFile } from "./userCliConfigFile.js";
import {
  migrateLegacyWorkspaceConfig,
  readWorkspaceConfigText,
  resolveWorkspaceConfigPath,
} from "./workspaceConfig.js";
import {
  WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS,
  WORKSPACE_MEMORY_EXPIRED_DIR_NAME,
  assertWorkspaceMemoryRootTrusted,
  isWorkspaceMemoryItemFileName,
  parseDateOnly,
  parseWorkspaceMemoryFrontmatter,
} from "./workspaceMemory.js";
import { reconcileWorkspaceMemoryIndex } from "./workspaceMemoryIndex.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

export interface WorkspaceMemoryExpiryVerdict {
  expired: boolean;
  /** `expires` 到期，还是闲置超过阈值。 */
  reason?: "expires" | "idle";
  /** 判定用的「最近一次活着」的时间点（毫秒）。 */
  anchorMs?: number;
}

/**
 * 单条记忆是否过期。
 *
 * `expires` 显式到期优先；否则按 `max(lastConfirmed, mtime)` 与阈值比。
 * 用 mtime 兜底是为了让没写 `lastConfirmed` 的旧文件不会被一次性清空。
 */
export function resolveWorkspaceMemoryExpiry(input: {
  content: string;
  mtimeMs: number;
  now: number;
  expiryDays: number;
}): WorkspaceMemoryExpiryVerdict {
  const frontmatter = parseWorkspaceMemoryFrontmatter(input.content);
  const today = startOfUtcDay(input.now);
  if (frontmatter.expires !== undefined) {
    const expiresAt = parseDateOnly(frontmatter.expires);
    if (expiresAt !== null && expiresAt <= today) return { expired: true, reason: "expires" };
  }
  if (input.expiryDays <= 0) return { expired: false };
  const lastConfirmed = frontmatter.lastConfirmed
    ? (parseDateOnly(frontmatter.lastConfirmed) ?? 0)
    : 0;
  const anchorMs = Math.max(lastConfirmed, input.mtimeMs);
  const idleDays = Math.floor((today - startOfUtcDay(anchorMs)) / DAY_MS);
  return idleDays >= input.expiryDays
    ? { expired: true, reason: "idle", anchorMs }
    : { expired: false, anchorMs };
}

/** 项目配置 `features.memoryExpiryDays`；缺省或非法时用默认值（0 = 只按 expires）。 */
export async function readWorkspaceMemoryExpiryDays(workspacePath: string): Promise<number> {
  const raw = await readWorkspaceConfigText(workspacePath);
  if (raw === null) return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
  }
  if (!isRecord(parsed)) return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
  const features = parsed.features;
  if (!isRecord(features)) return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
  const days = features.memoryExpiryDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
    return WORKSPACE_MEMORY_DEFAULT_EXPIRY_DAYS;
  }
  return Math.floor(days);
}

/**
 * 写入项目记忆过期阈值：只改 `features.memoryExpiryDays`，保留项目配置里的其它键。
 * `null` 删除配置回到默认（不按闲置时间清理）；`0` 与默认等价。
 */
export async function setWorkspaceMemoryExpiryDays(
  workspacePath: string,
  days: number | null,
): Promise<void> {
  await migrateLegacyWorkspaceConfig(workspacePath);
  const configPath = resolveWorkspaceConfigPath(workspacePath);
  const normalized = days === null ? null : Math.max(0, Math.floor(days));
  await updateJsonConfigFile(configPath, (current) => {
    const features = isRecord(current.features) ? { ...current.features } : {};
    const existing = features.memoryExpiryDays;
    if (normalized === null) {
      if (!("memoryExpiryDays" in features)) return null;
      delete features.memoryExpiryDays;
      return { ...current, features };
    }
    if (typeof existing === "number" && Math.floor(existing) === normalized) return null;
    return { ...current, features: { ...features, memoryExpiryDays: normalized } };
  });
}

/**
 * 清理过期记忆：移到 `.expired/` 子目录而不是直接删除，误判可恢复。
 *
 * 子目录不在 `readdir` 的 `isFile()` 结果里，注入、列表与对账都看不到它，
 * 所以移走等价于「从记忆里消失」，同时保留人工找回的可能。
 */
export async function pruneExpiredWorkspaceMemories(
  memoryRoot: string,
  options: { now?: number; expiryDays: number },
): Promise<{ removed: string[] }> {
  const now = options.now ?? Date.now();
  let entries;
  try {
    await assertWorkspaceMemoryRootTrusted(memoryRoot);
    entries = await readdir(memoryRoot, { withFileTypes: true });
  } catch {
    return { removed: [] };
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!isWorkspaceMemoryItemFileName(entry.name)) continue;
    const path = join(memoryRoot, entry.name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const content = await readFile(path, "utf-8");
      const verdict = resolveWorkspaceMemoryExpiry({
        content,
        mtimeMs: metadata.mtimeMs,
        now,
        expiryDays: options.expiryDays,
      });
      if (!verdict.expired) continue;
      const expiredRoot = join(memoryRoot, WORKSPACE_MEMORY_EXPIRED_DIR_NAME);
      await mkdir(expiredRoot, { recursive: true });
      let target = join(expiredRoot, entry.name);
      const collided = await lstat(target).then(
        () => true,
        () => false,
      );
      if (collided) target = join(expiredRoot, `${entry.name.slice(0, -3)}-${now}.md`);
      await rename(path, target);
      removed.push(entry.name);
    } catch {
      // 文件被占用 / 目录不可写：跳过这一条，记忆功能继续工作。
    }
  }
  if (removed.length > 0) await reconcileWorkspaceMemoryIndex(memoryRoot);
  return { removed };
}

/** 索引里的一行指针：`- [Title](file.md) — hook`。 */
