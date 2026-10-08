import { ensureAppDataDir } from "@zcode/shared/node";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PiPluginUpdateRecord = {
  id: string;
  source: string;
  scope: "user" | "project";
  name: string;
};

export type PiPluginUpdateCache = {
  checkedAt: number;
  updates: PiPluginUpdateRecord[];
};

const chains = new Map<string, Promise<void>>();

export function piPluginUpdateCacheKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

function cacheFile(key: string, root?: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(root ?? join(ensureAppDataDir(homedir())), "pi-plugin-update-cache", hash);
}

function recordOf(value: unknown): PiPluginUpdateRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.source !== "string" ||
    typeof row.name !== "string"
  ) {
    return undefined;
  }
  if (row.scope !== "user" && row.scope !== "project") return undefined;
  return { id: row.id, source: row.source, scope: row.scope, name: row.name };
}

function parseCache(raw: unknown, key: string): PiPluginUpdateCache | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (record.workspaceKey !== key) return undefined;
  if (typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)) return undefined;
  if (!Array.isArray(record.updates)) return undefined;
  const updates: PiPluginUpdateRecord[] = [];
  for (const item of record.updates) {
    const row = recordOf(item);
    if (!row) return undefined;
    updates.push(row);
  }
  return { checkedAt: record.checkedAt, updates };
}

async function enqueue(key: string, write: () => Promise<void>): Promise<void> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(write, write);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  await run;
}

export async function readPiPluginUpdateCache(
  key: string,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(key, root), "utf8")) as unknown;
    return parseCache(raw, key);
  } catch {
    return undefined;
  }
}

async function writePiPluginUpdateCache(
  key: string,
  updates: PiPluginUpdateRecord[],
  checkedAt: number,
  root?: string,
): Promise<void> {
  const file = cacheFile(key, root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ workspaceKey: key, checkedAt, updates }, null, 2)}\n`);
}

export async function savePiPluginUpdateCache(
  key: string,
  updates: PiPluginUpdateRecord[],
  checkedAt = Date.now(),
  root?: string,
): Promise<PiPluginUpdateCache> {
  const saved = { checkedAt, updates };
  await enqueue(key, () => writePiPluginUpdateCache(key, updates, checkedAt, root));
  return saved;
}

/** 更新成功后只去掉这个插件，检查时间保持不变，避免马上又自动检查。 */
export async function forgetPiPluginUpdate(
  key: string,
  id: string,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  let saved: PiPluginUpdateCache | undefined;
  await enqueue(key, async () => {
    const current = await readPiPluginUpdateCache(key, root);
    if (!current) return;
    saved = {
      checkedAt: current.checkedAt,
      updates: current.updates.filter((item) => item.id !== id),
    };
    await writePiPluginUpdateCache(key, saved.updates, saved.checkedAt, root);
  });
  return saved;
}
