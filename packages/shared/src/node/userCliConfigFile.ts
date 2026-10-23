import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureAppDataDir } from "./appDataDir.js";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";

/**
 * 用户级 CLI 配置文件（`<appData>/cli/config.json`）的**唯一读改写入口**。
 *
 * 这个文件原本由技能开关、命令开关、设置同步三个服务各自「读全量 → 改自己那几个 key →
 * 写全量」，且都用 `writeFile` 直接覆盖。三方只有进程内队列，跨服务无锁，后果是：
 *
 * 1. 后写者用旧快照覆盖他人刚写入的 `mcp.servers` / `plugins.dirs`（丢更新）；
 * 2. 写截断窗口里的读者会解析失败，而各方 `catch → {}` 把空对象当成「没有任何配置」，
 *    随后把空状态永久落盘。
 *
 * 这里把读写收敛成一处：文件锁串行 + temp/rename 原子落盘（见
 * docs/specs/cli-config-single-owner.md）。
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读改写回调：返回完整的新对象；返回 `null`/`undefined` 表示本次不写。 */
export type JsonConfigBuilder = (
  current: Record<string, unknown>,
) => Record<string, unknown> | null | undefined;

/**
 * `<appData>/cli/config.json`。
 *
 * 含 `ensureAppDataDir` 的目录迁移副作用（`.zcode` → `.PiCode`），**不要**把它存成模块级
 * 常量：迁移在早期因目录被占用失败时会返回 legacy 路径，模块级固化会让该进程此后一直写
 * 旧目录，与后续重新解析出来的新路径形成两个文件、两把锁。
 */
export function userCliConfigFilePath(homeDir: string): string {
  return join(ensureAppDataDir(homeDir), "cli", "config.json");
}

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 上被记事本（或某些编辑器/脚本）保存成 "UTF-8 with BOM" 时，`JSON.parse` 会抛
 * `Unexpected token`。如果不处理，这类文件会让技能/命令/配置的**每一次写**都失败，
 * 而报错只有一句 syntax error，用户完全无从自救。
 */
function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 读改写用的严格读取：只有「文件不存在」才当作空配置。
 *
 * 解析失败必须抛出 —— 否则一次偶然的半截读会变成「把整份配置写成空对象」，比丢失单次更新
 * 严重得多。
 */
async function readConfigForUpdate(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(stripByteOrderMark(raw)) as unknown;
  if (!isPlainRecord(parsed)) {
    // 合法 JSON 但不是对象（`[]` / `null` / `"x"`）属于文件损坏。按空配置处理再写回会
    // 直接把用户原有内容抹掉，这里必须显式失败。
    throw new TypeError(`Expected a JSON object at ${filePath}`);
  }
  return parsed;
}

/**
 * 任意 JSON 配置文件的「锁内读 → build → 原子写」。
 *
 * `build` 返回完整的新对象（可以原地改 `current` 再返回它）；返回 `null` 表示本次不写，
 * 用于「目标状态已经满足、无需落盘」的幂等分支。
 *
 * @returns 是否实际写入。
 */
export async function updateJsonConfigFile(
  filePath: string,
  build: JsonConfigBuilder,
): Promise<boolean> {
  return withFileLock(filePath, async () => {
    const current = await readConfigForUpdate(filePath);
    const next = build(current);
    // `undefined` 也要当成「不写」：`${JSON.stringify(undefined)}` 会落盘成字符串
    // `undefined`，那是损坏内容而不是空对象。
    if (next === null || next === undefined) {
      return false;
    }
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  });
}
