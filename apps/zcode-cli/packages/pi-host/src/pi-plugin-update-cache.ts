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
  checkedAt?: number;
  updates: PiPluginUpdateRecord[];
};

type StoredCache = {
  checkedAt: number;
  updates: PiPluginUpdateRecord[];
  /** 检查开始时间早于这个时间的结果不能把该插件写回可更新。 */
  superseded: Record<string, number>;
};

/** 用户范围的包装在本机用户目录，不能按工作区各存一份可更新结果。 */
const USER_PLUGIN_UPDATE_CACHE_KEY = "scope:user";

// shortcut: 同一进程内串行写。两个 Host 同时写时，后完成的检查可能把刚更新的用户包写回去，下次检查会纠正。
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

function supersededOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const superseded: Record<string, number> = {};
  for (const [id, at] of Object.entries(value)) {
    if (typeof at === "number" && Number.isFinite(at)) superseded[id] = at;
  }
  return superseded;
}

function parseCache(raw: unknown, key: string): StoredCache | undefined {
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
  return { checkedAt: record.checkedAt, updates, superseded: supersededOf(record.superseded) };
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

async function readStored(key: string, root?: string): Promise<StoredCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(key, root), "utf8")) as unknown;
    return parseCache(raw, key);
  } catch {
    return undefined;
  }
}

async function writeStored(
  key: string,
  updates: PiPluginUpdateRecord[],
  checkedAt: number,
  superseded: Record<string, number>,
  root?: string,
): Promise<void> {
  const file = cacheFile(key, root);
  await mkdir(dirname(file), { recursive: true });
  const body: Record<string, unknown> = { workspaceKey: key, checkedAt, updates };
  if (Object.keys(superseded).length > 0) body.superseded = superseded;
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

export async function readPiPluginUpdateCache(
  key: string,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  const stored = await readStored(key, root);
  return stored ? { checkedAt: stored.checkedAt, updates: stored.updates } : undefined;
}

function checkedAtOf(stored: StoredCache | undefined): number | undefined {
  return stored && stored.checkedAt > 0 ? stored.checkedAt : undefined;
}

/** 用户范围看全局缓存，项目范围看当前工作区。旧工作区文件里的用户范围记录忽略。 */
export async function readPiPluginUpdateView(
  workspaceKey: string,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  const user = await readStored(USER_PLUGIN_UPDATE_CACHE_KEY, root);
  const project = await readStored(workspaceKey, root);
  if (!user && !project) return undefined;
  const updates = [
    ...(user?.updates ?? []).filter((item) => item.scope === "user"),
    ...(project?.updates ?? []).filter((item) => item.scope === "project"),
  ];
  const userAt = checkedAtOf(user);
  const projectAt = checkedAtOf(project);
  return {
    updates,
    ...(userAt !== undefined && projectAt !== undefined
      ? { checkedAt: Math.min(userAt, projectAt) }
      : {}),
  };
}

export async function savePiPluginUpdateCache(
  key: string,
  updates: PiPluginUpdateRecord[],
  checkedAt = Date.now(),
  root?: string,
): Promise<PiPluginUpdateCache> {
  const saved = { checkedAt, updates };
  await enqueue(key, async () => {
    const current = await readStored(key, root);
    await writeStored(key, updates, checkedAt, current?.superseded ?? {}, root);
  });
  return saved;
}

async function commitScope(
  key: string,
  incoming: PiPluginUpdateRecord[],
  startedAt: number,
  root?: string,
): Promise<void> {
  await enqueue(key, async () => {
    const current = await readStored(key, root);
    if (current && current.checkedAt > startedAt) return;
    const superseded = { ...current?.superseded };
    const updates = incoming.filter((item) => (superseded[item.id] ?? -1) < startedAt);
    for (const id of Object.keys(superseded)) {
      if ((superseded[id] ?? -1) < startedAt) delete superseded[id];
    }
    await writeStored(key, updates, Date.now(), superseded, root);
  });
}

/** `startedAt` 是这次检查开始的时间。更早开始的结果不能盖掉之后的更新。 */
export async function savePiPluginUpdateCheck(
  workspaceKey: string,
  updates: PiPluginUpdateRecord[],
  startedAt: number,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  await commitScope(
    USER_PLUGIN_UPDATE_CACHE_KEY,
    updates.filter((item) => item.scope === "user"),
    startedAt,
    root,
  );
  await commitScope(
    workspaceKey,
    updates.filter((item) => item.scope === "project"),
    startedAt,
    root,
  );
  return readPiPluginUpdateView(workspaceKey, root);
}

function cacheKeyFor(workspaceKey: string, id: string): string {
  return id.startsWith("pkg:user:") ? USER_PLUGIN_UPDATE_CACHE_KEY : workspaceKey;
}

/** 更新或卸掉成功后只去掉这个插件，检查时间保持不变，避免马上又自动检查。 */
export async function forgetPiPluginUpdate(
  workspaceKey: string,
  id: string,
  root?: string,
): Promise<PiPluginUpdateCache | undefined> {
  const key = cacheKeyFor(workspaceKey, id);
  await enqueue(key, async () => {
    const current = (await readStored(key, root)) ?? {
      checkedAt: 0,
      updates: [],
      superseded: {},
    };
    await writeStored(
      key,
      current.updates.filter((item) => item.id !== id),
      current.checkedAt,
      { ...current.superseded, [id]: Date.now() },
      root,
    );
  });
  return readPiPluginUpdateView(workspaceKey, root);
}
