# `<appData>/cli/config.json`：单一 owner 与原子读改写

## 背景

用户级 CLI 配置 `<appData>/cli/config.json` 是**四个服务**共享的可写文件：

| 写者 | 位置 | 写的键 |
| --- | --- | --- |
| 技能开关 | `packages/services/src/skills/skillsService.ts` | `skills` |
| 命令开关 | `packages/services/src/commands/commandsService.ts` | `command` |
| 设置同步 | `packages/services/src/settings-sync/settingsSyncService.ts` | `mcp` / `plugins` |
| 插件同步 | `packages/services/src/plugin-sync/pluginSyncService.ts` | `plugins` |

四方都是「读全量 → 改自己那几个 key → 写全量」。改造前各方都用 `writeFile` 直接覆盖
（先截断再写），各自只有进程内队列，**跨服务无锁**。注意 `settings-sync` 与 `plugin-sync`
写的是同一个 `plugins` 子树，互相覆盖是必然的。

两类后果：

1. **丢更新**：后写者用旧快照覆盖他人刚写入的键。典型现场是"设置页关技能的同一次交互里
   装了个插件"。
2. **读到半截 JSON**：`readFile` 撞上截断窗口 → 解析失败 → 各方 `catch {} → {}` 把空对象
   当成"配置为空"，所有技能/命令开关瞬间显示默认值，**下一次写入把这个空状态永久落盘**。

`node.ts` 还用 `readFileSync` 同步读同一文件，截断窗口直接卡 Host 主线程。

## 状态所有者

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| `cli/config.json` 内容 | **`packages/shared/src/node/userCliConfigFile.ts`** | 唯一读改写入口 |
| 文件锁 | `withFileLock(filePath)` | 与 `mcpUserDirectory`、`mcpSyncService` 共用同一 `.lock` 约定 |
| 各服务的字段语义 | 各服务自身 | 只通过 `build(config)` 回调修改自己的键 |
| 路径字符串 | `userCliConfigFilePath(homeDir)` | 每次调用重算，**不缓存** |

## 规则

1. **同一文件的读改写必须在文件锁内完成。** 提供 `updateJsonConfigFile(filePath, build)`：
   锁 → 读 → `build(config)` → 原子写。`build` 返回**完整的新 config**（不是原地修改），
   让"只改一个字段"和"整份替换"共用一条路径。返回 `null` / `undefined` 表示本次不写
   （用于「目标状态已满足」的幂等分支）。
2. **写必须原子。** 用 `atomicWritePrivateTextFile`（temp + rename + `0o600`，含 rename
   重试）。直接 `writeFile` 会让任何并发读者看到半截文件，这是上面第 2 类后果的唯一根因。
3. **写入路径的读取必须严格。** `updateJsonConfigFile` 内部只有「文件不存在（ENOENT）」
   才当作空配置；以下情况**必须抛出**，绝不把空对象写回去：
   - 解析失败（含文件被截断）；
   - 合法 JSON 但不是对象（`[]` / `null` / `"x"`）—— 按空配置写回会直接抹掉用户内容。
   展示路径各自保留自己的 `catch {} -> {}` 实现（见「未覆盖」），本模块不提供无锁只读。
4. **UTF-8 BOM 必须剥离。** Windows 上被记事本存成 "UTF-8 with BOM" 的文件会让
   `JSON.parse` 抛 `Unexpected token`；不处理的话技能/命令/配置的**每一次写**都会失败，
   报错只有一句 syntax error，用户无从自救。
5. **路径解析不能模块级固化。** `ensureAppDataDir()` 含 `.zcode → .PiCode` 的目录迁移，
   迁移在早期因目录被占用而失败时会返回 legacy 路径。若把它存成模块级常量，该进程此后
   会一直写旧目录，与其它服务重新解析出的新路径形成**两个文件、两把锁**。
   一律在写函数内调 `userCliConfigFilePath(resolveUserHomeDir())`。
6. **workspace 级配置复用同一实现。** `settingsSyncService` 的
   `addPluginDirToConfig(filePath, …)` 的 `filePath` 既可能是 user cli config，也可能是
   workspace config。因此底层接口按**路径**工作，用户级路径由上层算出来传入。
7. **不要在锁内嵌套调用同一路径的 `updateJsonConfigFile`。** `withFileLock` 的进程内 FIFO
   段（`await previousTail`）没有超时，5 秒超时只覆盖 OS 目录锁；嵌套会让内层等一个永不
   resolve 的 tail，表现为永久挂起而不是超时失败。

## 接口

```ts
// packages/shared/src/node/userCliConfigFile.ts

/** 读改写回调：返回完整新对象；返回 null/undefined 表示本次不写。 */
export type JsonConfigBuilder = (
  current: Record<string, unknown>,
) => Record<string, unknown> | null | undefined;

/**
 * `<appData>/cli/config.json`。含 ensureAppDataDir 的迁移副作用，不要存成模块级常量。
 */
export function userCliConfigFilePath(homeDir: string): string;

/** 任意 JSON 配置文件：锁内读 → build → 原子写。@returns 是否实际写入。 */
export async function updateJsonConfigFile(
  filePath: string,
  build: JsonConfigBuilder,
): Promise<boolean>;
```

调用方形态：

```ts
// 四个写者统一成这样
await updateJsonConfigFile(userCliConfigFilePath(resolveUserHomeDir()), (config) => {
  /* 只改自己的键，返回整份 config */
  return config;
});

// 幂等分支
await updateJsonConfigFile(filePath, (parsed) => {
  if (已经登记过) return null; // 不落盘
  return { ...parsed, plugins: { ...plugins, dirs: [...dirs, resolved] } };
});
```

## 验收场景

- 四个写者并发读改写同一文件：所有修改**都**保留，不出现互相覆盖。
- 写入过程中用另一个进程反复读取：任何一次 `JSON.parse` 都成功，不出现空对象。
- `skills` / `command` / `mcp` / `plugins` 四个顶层键互不干扰：改技能开关后 `command`
  字段逐字节不变。
- `plugins.dirs` 去重逻辑保持：同一路径重复导入不产生第二条，且**不重写文件**（mtime 不变）。
- 写入后临时文件不残留（`.tmp` 数为 0）。
- 文件内容损坏（半截 JSON / 带 BOM / `[]`）时：读取路径不静默，写入路径抛出且**原文件逐
  字节不变**。
- 同一路径的 workspace 级配置与 user 级配置各自独立加锁，不互相阻塞超过必要时间。

## 未覆盖（记录为后续项）

- **CLI 进程是另一族写者**：`apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts`
  （`DEFAULT_BASE_DIR = "~/.PiCode/cli"` + `config.json`）有 8 个「读 → patch → 原子写」函数，
  **不带 `.lock`**。它写的是同一份用户级文件，但属于另一个进程。
  额外风险：CLI 侧用 `homedir()`，services 侧用 `HOME || USERPROFILE || homedir()`；Windows
  上 Git Bash 的 `HOME=/c/Users/x` 与 `os.homedir()=C:\Users\x` 不同 → 两边连文件都不一致。
  要覆盖它需要在这些 patch 外面套 `withFileLock`，并统一 home 解析，单独立项。
- **展示路径的读取容错**：`readUserCliConfig`（commandsService）/ `readCliConfigFile`
  （skillsService）/ `readJsonFileOrEmpty`（settingsSyncService / pluginSyncService）仍是
  `catch {} → {}`。它们只用于「读一次给人看」，但取到的空对象会被上层当成「没有任何
  override」，从而让技能/命令在解析失败的那一瞬显示成默认值。
- **`skillsService` 的读仍在锁外**：`readSkillEnabledMap()` 在 `writeSkillEnabledMap` 之前
  读一次快照，写入时才进锁。当前 `skills` 键只有这一个写者，不可观测；要彻底合规需要把
  delta（单条 path → enabled）传进去，在 `build` 里合并。
- **`deleteCommandFile` 的脏 override**：先 `rm` 命令文件（成功）再写 config，若写 config
  抛错，`command` 里会留下指向已删除文件的 override。解析失败现在是硬失败，这条路径需要
  「先写 config 再删文件」或失败回滚。
- `packages/services/src/fs/atomicFileUtils.ts` 的 `atomicWriteText` 每次写都 `readdir`
  目标目录清陈旧 tmp。本模块改用 shared 的 `atomicWritePrivateTextFile`（不做目录扫描），
  不受该问题影响。
- `node.ts` 里用 `readFileSync` 同步读同一文件的那条路径未改。文件被原子替换后它不会再读到
  半截内容，但仍是同步 IO。
