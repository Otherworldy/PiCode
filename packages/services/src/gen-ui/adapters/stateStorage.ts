import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { acquireFileLock } from "@zcode/shared/node";
import { z } from "zod";
import {
  buildGenUiScopeKey,
  GEN_UI_STATE_MAX_ENTRIES,
  genUiScopeSchema,
  genUiStateTargetSchema,
  genUiWidgetStateSchema,
  type GenUiScope,
  type GenUiStateChange,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";
import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type { GenUiStateStorage } from "../app/ports.js";

const MAX_RECORD_BYTES = 96 * 1024;
const LOCK_RETRIES = [25, 50, 100, 200, 400] as const;
const recordSchema = z
  .object({ target: genUiStateTargetSchema, state: genUiWidgetStateSchema, updatedAt: z.number() })
  .strict();
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const isMissing = (error: unknown) => (error as { code?: string })?.code === "ENOENT";

export function createGenUiStateStorage(root: string): GenUiStateStorage {
  const log = createServiceLogger("gen-ui-state");
  const changes = new Emitter<GenUiStateChange>();
  const watchers = new Map<string, FSWatcher>();
  const queues = new Map<string, Promise<void>>();
  const notifications = new Map<string, Promise<void>>();
  const lastPublished = new Map<string, string>();
  const targets = new Map<string, GenUiStateTarget>();
  let disposed = false;
  /**
   * 同时保持打开的 scope 目录观察数上限。
   *
   * key 是 (workspaceKey, sessionId) 的哈希，也就是「用过 gen-ui 状态的会话各占一个」。
   * 没有上限时长跑一天切过几百个会话就是几百个常驻目录句柄：Linux 上会逼近
   * max_user_watches 让 fs.watch 直接 ENOSPC，Windows 上每个占一个目录句柄 + 线程池槽。
   */
  const MAX_WATCHED_SCOPES = 8;

  /**
   * 丢弃一个目录下的派生缓存。
   *
   * **不能清 `targets`**：`targets` 是「文件 → 属于哪个 target」的映射，而 `publishLatest`
   * 依赖它，缺失时直接 return。一个 session 下可以有多张 gen-ui 卡片共用同一个目录，watcher
   * 被淘汰后只要有一张卡片重新 observe，其余卡片就会变成「watcher 在场、事件到达、通知被静默
   * 丢弃」。targets 条目本身很小，留着不影响内存目标。
   */
  function forgetDirectory(dir: string): void {
    const prefix = `${dir}/`;
    // Map 迭代器允许在遍历中删除当前元素。
    for (const file of targets.keys()) {
      if (!file.startsWith(prefix)) continue;
      lastPublished.delete(file);
      notifications.delete(file);
    }
  }

  /** 按插入顺序淘汰最旧的 scope 目录（FIFO；这里不做「命中即刷新」的代价是不必要的重扫）。 */
  function evictWatchScopes(): void {
    while (watchers.size > MAX_WATCHED_SCOPES) {
      const oldest = watchers.keys().next().value;
      if (oldest === undefined) return;
      watchers.get(oldest)?.close();
      watchers.delete(oldest);
      forgetDirectory(oldest);
    }
  }

  const directory = (scope: GenUiScope) => join(root, hash(buildGenUiScopeKey(scope)));
  const fileFor = (target: GenUiStateTarget) =>
    join(directory(target), `${hash(target.path)}.json`);
  async function readRecord(file: string) {
    try {
      if ((await stat(file)).size > MAX_RECORD_BYTES)
        throw new Error("Invalid Gen UI state record size");
      return recordSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  async function publishLatest(file: string) {
    const target = targets.get(file);
    if (disposed || !target) return;
    const state = (await readRecord(file))?.state ?? null;
    const serialized = JSON.stringify(state);
    if (disposed || lastPublished.get(file) === serialized) return;
    lastPublished.set(file, serialized);
    changes.fire({ target, state });
  }
  function publish(file: string) {
    // watch 事件与写入 ACK 可以同时触发；串行读取防止较早快照迟到覆盖较新通知。
    const next = (notifications.get(file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => publishLatest(file));
    notifications.set(file, next);
    void next
      .finally(() => {
        if (notifications.get(file) === next) notifications.delete(file);
      })
      .catch(() => undefined);
    return next;
  }
  async function observe(target: GenUiStateTarget) {
    if (disposed) throw new Error("Gen UI state storage is closed");
    const dir = directory(target);
    await mkdir(dir, { recursive: true });
    if (disposed) throw new Error("Gen UI state storage is closed");
    targets.set(fileFor(target), target);
    const existingWatcher = watchers.get(dir);
    if (existingWatcher) {
      // 命中即刷新顺序，做成真正的 LRU：否则正在使用的 scope 会被新 scope 按 FIFO 淘汰
      // （用户开着看板再连开几个用过 gen-ui 的会话就丢掉跟踪）。
      watchers.delete(dir);
      watchers.set(dir, existingWatcher);
      return;
    }
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename || !/^[a-f0-9]{64}\.json$/u.test(filename)) return;
      void publish(join(dir, filename)).catch((error: unknown) =>
        log.warn(undefined, "State notification failed", { error: String(error) }),
      );
    });
    watcher.on("error", (error) =>
      log.warn(undefined, "State watcher failed", { error: error.message }),
    );
    watchers.set(dir, watcher);
    evictWatchScopes();
  }
  async function records(scope: GenUiScope) {
    const dir = directory(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const items = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .map(async (name) => {
          const file = join(dir, name),
            record = await readRecord(file);
          return record && buildGenUiScopeKey(record.target) === buildGenUiScopeKey(scope)
            ? { file, ...record }
            : null;
        }),
    );
    return items.filter((item) => item !== null).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return {
    onChanged: changes.event,
    async get(raw) {
      const target = genUiStateTargetSchema.parse(raw);
      await observe(target);
      const record = await readRecord(fileFor(target));
      const state = record?.state ?? null;
      // 读取不能吞掉其他页面等待的变更通知；只为首次观察建立比较基线。
      if (!lastPublished.has(fileFor(target)))
        lastPublished.set(fileFor(target), JSON.stringify(state));
      return state;
    },
    set(raw, value) {
      const target = genUiStateTargetSchema.parse(raw),
        state = genUiWidgetStateSchema.parse(value);
      const key = buildGenUiScopeKey(target);
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await observe(target);
          // 所有窗口复用同一会话锁；完整快照写入与容量淘汰属于同一个提交，不能各自读改写目录清单。
          const release = await acquireFileLock(
            join(directory(target), "state"),
            LOCK_RETRIES,
            100,
            8000,
          );
          try {
            const existing = await records(target);
            const updatedAt = Math.max(Date.now(), (existing[0]?.updatedAt ?? 0) + 1);
            await atomicWriteText(fileFor(target), JSON.stringify({ target, state, updatedAt }), {
              useFileLock: false,
            });
            for (const record of existing
              .filter((record) => record.file !== fileFor(target))
              .slice(GEN_UI_STATE_MAX_ENTRIES - 1))
              await rm(record.file, { force: true });
          } finally {
            await release();
          }
          await publish(fileFor(target));
        });
      queues.set(key, run);
      void run
        .finally(() => {
          if (queues.get(key) === run) queues.delete(key);
        })
        .catch(() => {});
      return run;
    },
    async list(raw) {
      return (await records(genUiScopeSchema.parse(raw)))
        .slice(0, GEN_UI_STATE_MAX_ENTRIES)
        .map((entry) => ({ path: entry.target.path, state: entry.state }));
    },
    dispose() {
      disposed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      targets.clear();
      lastPublished.clear();
      changes.dispose();
    },
  };
}
