import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import { resolveProjectMemoryRoot } from "@zcode/core";
import {
  ensureAppDataDir,
  ensureWorkspaceMemoryRoot,
  isWorkspaceMemoryFileName,
  isWorkspaceMemorySupported,
  pruneExpiredWorkspaceMemories,
  readWorkspaceMemoryEnabled,
  readWorkspaceMemoryExpiryDays,
  resolveWorkspaceMemoryRoot,
} from "@zcode/shared/node";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  isPicodeSubagentSessionFile,
  readPiJsonl,
  summarizePiJsonl,
  type HostedSession,
  type HostSessionRegistry,
  type PiStoredSession,
} from "@zcode/pi-host";
import { isBareSlashCommandTitle, type ZCodeWorkspaceRef } from "@zcode/shared";
import { projectIdFromDirectory } from "../app/paths.js";
import { createPiHostedApp } from "../app/pi-hosted-app.js";
import {
  permissionWithCollaborationMode,
  storedCollaborationMode,
} from "./hosted-collaboration-mode.js";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

/** publisher 还是空的时，按 jsonl 重画。生成中不重画，避免冲掉还没落盘的这一轮。 */
export async function restoreHostedProjection(hosted: HostedSession): Promise<void> {
  if (!hosted.isIdle) return;
  const content = await readFile(hosted.sessionFile, "utf8").catch(() => "");
  if (readPiJsonl(content).events.length === 0) return;
  hosted.reloadHistory(content);
}

export async function bindHostedSession(
  context: ZCodeProtocolAgentServerContext,
  hosted: HostedSession,
  workspace: ZCodeWorkspaceRef,
): Promise<ZCodeProtocolSessionRecord> {
  const sessionId = hosted.sessionId as SessionId;
  const app = createPiHostedApp(hosted, {
    abortWork: (workId) => {
      if (!context.piHost) return Promise.resolve(false);
      return context.piHost.abort(workId);
    },
    persistSession: async (title) => {
      const store = context.deps.sessionStore;
      if (!store) return;
      const compact = title.trim().replace(/\s+/g, " ");
      // 计划模式的第一条 admission 是 /plannotator-plan-mode。写进 first_input 后，
      // 侧栏会一直显示这条命令，直到点开会话才按 jsonl 重算。
      const visibleTitle = compact && !isBareSlashCommandTitle(compact) ? compact.slice(0, 60) : "";
      const existing = await store.getSession(sessionId);
      await store.createSession({
        id: sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        ...(workspace.workspaceIdentity
          ? { workspaceID: workspace.workspaceIdentity as WorkspaceId }
          : {}),
        slug: sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "session",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: visibleTitle || "Untitled session",
        titleSource: "first_input",
        version: context.deps.version ?? "0.0.0",
        // 冲突更新会整份换掉 permission。写死 build 会把已经保存的完全访问抹掉，
        // 进程重启后工具闸回到 build，输入框却还显示完全访问。
        permission: permissionWithCollaborationMode(
          existing?.permission,
          hosted.projector.getSnapshot().config.mode,
        ),
        traceID: createRootTraceContext({ sessionId }).traceId,
        // 打开子代理转录会走到这里。写成普通会话后，左侧列表会多出一行。
        ...(isPicodeSubagentSessionFile(hosted.sessionFile)
          ? { taskType: "subagent_child" as const }
          : {}),
      });
    },
    onCollaborationMode: (mode) => {
      void persistHostedCollaborationMode(context, sessionId, mode);
    },
  });
  const summary = summarizePiJsonl(await readFile(hosted.sessionFile, "utf8").catch(() => ""));
  // jsonl 已有内容会标成 immediate，admission 就不再补 session 行。
  // session_input 外键要求这行先在，否则打开旧会话后的第一条发送直接 FOREIGN KEY constraint failed。
  if (summary && context.deps.sessionStore) {
    const existing = await context.deps.sessionStore.getSession(sessionId);
    if (!existing) await app.runtime.ensureSessionPersistedForExternalActivity(summary.title);
    else if (
      isBareSlashCommandTitle(existing.title) &&
      summary.title &&
      !isBareSlashCommandTitle(summary.title)
    ) {
      // 旧行还停在命令标题。打开时用 jsonl 的真实标题换掉，避免下次回源又写回去。
      await context.deps.sessionStore.updateSession({
        id: sessionId,
        title: summary.title.slice(0, 60),
        titleSource: "generated",
        expectedTitleSources: ["first_input", "default", "generated"],
      });
    }
  }
  const record: ZCodeProtocolSessionRecord = {
    app,
    memoryEnabled: hosted.memoryEnabledAtCreation,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "legacy",
    createdAt: summary?.createdAt ?? Date.now(),
    eventStore:
      context.deps.createSessionEventStore?.(sessionId) ?? createInMemorySessionEventStore(),
    ...(hosted.parentSessionId ? { parentSessionId: hosted.parentSessionId as SessionId } : {}),
    // 子代理 jsonl 在父目录的 picode-subagent 下。挂上类型后 sessions-index 不会收它。
    ...(isPicodeSubagentSessionFile(hosted.sessionFile)
      ? { taskType: "subagent_child" as const }
      : {}),
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: createRootTraceContext({ sessionId }),
    updatedAt: summary?.lastActivityAt ?? Date.now(),
    workspace,
    persistence: summary ? "immediate" : "deferred",
  };
  // 必须先恢复模式再入注册表。命令进来时若还是 build，完全访问下的工具会先弹窗。
  await restoreHostedCollaborationMode(context, hosted);
  // 历史 delta 在订阅时一次性吐出。必须先入注册表，sessions-index 才能按 workspace 挂上侧栏。
  context.sessions.set(sessionId, record);
  const unsubscribeDeltas = hosted.onDeltas((deltas) => {
    context.v4Gateway?.ingestPiDeltas(sessionId, deltas);
  });
  record.unsubscribe = () => {
    unsubscribeDeltas();
    hosted.dispose();
  };
  const snapshot = hosted.projector.getSnapshot();
  const title = snapshot.meta.title.trim() || summary?.title || "";
  const subagentTranscript = isPicodeSubagentSessionFile(hosted.sessionFile);
  // 分支文件已经在磁盘上。增量如果被 draft 过滤掉，当前列表要到重启重扫才看得到。
  // 子代理转录只在父会话里看。reveal 会把它写成左侧一行。
  if (title && !subagentTranscript) {
    record.persistence = "immediate";
    context.v4Gateway?.revealStoredSession(workspace.workspaceKey, {
      sessionId,
      workspaceId: workspace.workspaceKey,
      ...(hosted.parentSessionId ? { parentSessionId: hosted.parentSessionId } : {}),
      title,
      titleSource:
        snapshot.meta.titleSource === "default" ? "generated" : snapshot.meta.titleSource,
      phase: snapshot.control.phase === "draft" ? "completedSuccess" : snapshot.control.phase,
      sessionEnded: snapshot.control.sessionEnded,
      hasBackgroundWork: snapshot.backgroundWorks.some((work) => work.status === "running"),
      lastActivityAt: summary?.lastActivityAt ?? Date.now(),
      createdAt: summary?.createdAt ?? record.createdAt,
      ...(summary?.lastAssistantPreview
        ? { lastAssistantPreview: summary.lastAssistantPreview }
        : {}),
      ...(summary?.cwd && summary.cwd !== workspace.workspacePath
        ? { workingDirectory: summary.cwd }
        : {}),
    });
  }
  return record;
}

/** 模式只活在内存里的话，进程退出后重建的会话会回到 build，完全访问仍会弹窗。 */
async function persistHostedCollaborationMode(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  mode: string,
): Promise<void> {
  const store = context.deps.sessionStore;
  const stored = storedCollaborationMode(mode);
  if (!store || !stored) return;
  try {
    const existing = await store.getSession(sessionId);
    if (!existing || existing.permission?.mode === stored) return;
    await store.updateSession({
      id: sessionId,
      permission: permissionWithCollaborationMode(existing.permission, stored),
    });
  } catch (error) {
    context.logger?.warn("pi-host collaboration mode was not persisted", {
      error: error instanceof Error ? error.message : String(error),
      mode: stored,
      sessionId,
    });
  }
}

async function restoreHostedCollaborationMode(
  context: ZCodeProtocolAgentServerContext,
  hosted: HostedSession,
): Promise<void> {
  const store = context.deps.sessionStore;
  if (!store) return;
  const existing = await store.getSession(hosted.sessionId as SessionId);
  const mode = storedCollaborationMode(existing?.permission?.mode);
  if (!mode || mode === hosted.projector.getSnapshot().config.mode) return;
  hosted.setCollaborationMode(mode);
}

export async function createPiSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: {
    workspace: ZCodeWorkspaceRef;
    sessionId?: string;
    parentSessionId?: string;
    mcpServers?: ZCodeProtocolMcpServer[];
    workingDirectory?: string;
    /** 冷恢复在 create 之前那次 find 的耗时，并进 open timing 的 readJsonlMs。 */
    openReadMs?: number;
    /** 冷恢复已经找到的 jsonl。传入后 create 不再 find。 */
    storedSession?: PiStoredSession;
  },
): Promise<ZCodeProtocolSessionRecord> {
  const registry = context.piHost;
  if (!registry) throw new Error("pi-host registry missing");
  // 能力位与开关分开：能力位决定是否注册注入扩展，开关每轮由扩展重读。
  // 只有开关在创建时会顺手建目录并迁移旧全局记忆，之后改开关不再重开会话。
  const memoryCapable = isWorkspaceMemorySupported(params.workspace.workspaceIdentity);
  const memoryEnabledAtCreation = memoryCapable
    ? await preparePiWorkspaceMemory(context, params.workspace)
    : false;
  const hosted = await registry.create({
    workspaceIdentity: params.workspace.workspaceIdentity,
    workspacePath: params.workspace.workspacePath,
    workingDirectory: params.workingDirectory,
    sessionId: params.sessionId ?? createSessionId(),
    parentSessionId: params.parentSessionId,
    memoryEnabled: memoryCapable,
    memoryEnabledAtCreation,
    ...(params.openReadMs !== undefined ? { openReadMs: params.openReadMs } : {}),
    ...(params.storedSession ? { storedSession: params.storedSession } : {}),
  });
  context.logger?.info("workspace memory hosted", {
    sessionId: hosted.sessionId,
    memoryCapable,
    memoryEnabledAtCreation: hosted.memoryEnabledAtCreation,
    workspacePath: params.workspace.workspacePath,
  });
  return bindHostedSession(context, hosted, params.workspace);
}

/** 每个 workspace 只尝试一次旧数据迁移，避免每次打开会话都扫旧目录。 */
const migratedWorkspaceMemory = new Set<string>();

/**
 * 读本地项目 `.pi/picode.json` 的开关，打开时顺手建目录并把旧全局目录里的 .md
 * 惰性复制过来。返回创建那一刻的开关值，只作为会话初始值。
 */
async function preparePiWorkspaceMemory(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): Promise<boolean> {
  try {
    if (!(await readWorkspaceMemoryEnabled(workspace.workspacePath))) {
      context.logger?.info("workspace memory resolve", {
        reason: "project switch off",
        workspacePath: workspace.workspacePath,
      });
      return false;
    }
    const key = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
    const newRoot = resolveWorkspaceMemoryRoot(workspace.workspacePath);
    const shouldMigrate =
      !migratedWorkspaceMemory.has(key) && (await isWorkspaceMemoryRootEmpty(newRoot));
    await ensureWorkspaceMemoryRoot(workspace.workspacePath);
    if (shouldMigrate) {
      migratedWorkspaceMemory.add(key);
      await migrateLegacyWorkspaceMemory(workspace);
    }
    // 过期记忆在打开会话时顺手清一次：只在开关为开、本地工作区时跑到这里。
    const { removed } = await pruneExpiredWorkspaceMemories(newRoot, {
      expiryDays: await readWorkspaceMemoryExpiryDays(workspace.workspacePath),
    });
    if (removed.length > 0) {
      context.logger?.info("workspace memory pruned", {
        count: removed.length,
        files: removed,
        workspacePath: workspace.workspacePath,
      });
    }
    context.logger?.info("workspace memory resolve", {
      reason: "enabled",
      workspacePath: workspace.workspacePath,
      memoryRoot: newRoot,
    });
  } catch (error) {
    context.logger?.warn("workspace memory root unavailable", {
      error: error instanceof Error ? error.message : String(error),
      workspacePath: workspace.workspacePath,
    });
    return false;
  }
  return true;
}

/** 目录不存在或还没有任何记忆 Markdown。已有 items 但缺 index 也算“已有记忆”，不再灌旧索引。 */
async function isWorkspaceMemoryRootEmpty(memoryRoot: string): Promise<boolean> {
  try {
    const entries = await readdir(memoryRoot);
    return !entries.some((entry) => entry.endsWith(".md"));
  } catch {
    return true;
  }
}

/**
 * 旧数据在全局数据目录里，目录名是 identity/path 的 hash，无法反向枚举。
 * 只能在打开某个 workspace 时按同一规则重算旧路径，复制到项目内；旧目录保留。
 */
async function migrateLegacyWorkspaceMemory(workspace: ZCodeWorkspaceRef): Promise<void> {
  const newRoot = resolveWorkspaceMemoryRoot(workspace.workspacePath);
  const oldRoot = resolveProjectMemoryRoot({
    cliStorageRoot: join(ensureAppDataDir(homedir()), "cli"),
    workspaceIdentity: workspace.workspaceIdentity,
    workspacePath: workspace.workspacePath,
  });
  let entries;
  try {
    entries = await readdir(oldRoot, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(newRoot, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!isWorkspaceMemoryFileName(entry.name)) continue;
    try {
      await copyFile(
        join(oldRoot, entry.name),
        join(newRoot, entry.name),
        fsConstants.COPYFILE_EXCL,
      );
    } catch {
      // 同名文件已经存在或复制失败：保留新旧两份，不阻塞会话创建。
    }
  }
}

export async function listPiStoredSummaries(registry: HostSessionRegistry, workspaceId: string) {
  const listed = await registry.list(workspaceId);
  return listed.map((item) => ({
    sessionId: item.sessionId,
    workspaceId,
    title: item.title,
    titleSource: "generated" as const,
    phase: "completedSuccess" as const,
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: item.lastActivityAt,
    createdAt: item.createdAt,
    ...(item.lastAssistantPreview ? { lastAssistantPreview: item.lastAssistantPreview } : {}),
    ...(item.cwd && item.cwd !== workspaceId ? { workingDirectory: item.cwd } : {}),
    // 磁盘上已经存在的分叉关系必须进 sessions-index，否则 tasks-index 的
    // forked_from_task_id 永远为空，分支图谱和父会话追溯都拿不到边。
    ...(item.parentSessionId ? { parentSessionId: item.parentSessionId } : {}),
  }));
}
