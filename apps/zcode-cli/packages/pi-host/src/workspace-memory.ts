import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  WORKSPACE_MEMORY_INDEX_FILE_NAME,
  WORKSPACE_MEMORY_INDEX_MAX_CHARS,
  WORKSPACE_MEMORY_INDEX_MAX_LINES,
  WORKSPACE_MEMORY_INDEX_READ_MAX_BYTES,
  WORKSPACE_MEMORY_MAX_INDEX_BYTES,
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  assertWorkspaceMemoryRootTrusted,
  atomicWritePrivateTextFile,
  formatWorkspaceMemoryPointerLine,
  isWorkspaceMemoryItemFileName,
  parseWorkspaceMemoryFrontmatter,
  reconcileWorkspaceMemoryIndex,
} from "@zcode/shared/node";

/** 记忆段在完整 prompt 里的起始标记；每轮先剪掉旧段，避免 force prompt 越积越长。 */
const WORKSPACE_MEMORY_PROMPT_MARKER = "<!-- zcode:workspace-memory -->";

/**
 * 抽取频率闸门：距上次抽取经过 N 个 turn 或 T 毫秒后，才允许下一次抽取。
 * 逐个 turn 都抽会把「改错别字」这类短轮次也写成一条记忆。
 */
export const WORKSPACE_MEMORY_EXTRACTION_MIN_TURNS = 3;
export const WORKSPACE_MEMORY_EXTRACTION_MIN_INTERVAL_MS = 10 * 60_000;

/** 频率闸门：攒够 turn 数或等够时间，才允许下一次抽取。 */
export function shouldRunWorkspaceMemoryExtraction(input: {
  turnsSinceLast: number;
  elapsedMs: number;
}): boolean {
  return (
    input.turnsSinceLast >= WORKSPACE_MEMORY_EXTRACTION_MIN_TURNS ||
    input.elapsedMs >= WORKSPACE_MEMORY_EXTRACTION_MIN_INTERVAL_MS
  );
}

const MEMORY_USAGE = [
  "This is your persistent workspace memory. Each memory is one Markdown file holding one fact.",
  "Write memories with the Write tool directly into this directory; it already exists.",
  "After writing a file, add one pointer line to `MEMORY.md`: `- [Title](file.md) — hook`.",
  "`MEMORY.md` is an index only. Keep one line per memory and never put memory content there.",
  "Check existing files before adding a duplicate; update or delete memories that turn out to be wrong.",
  "Do not save what the repository already records (code structure, past fixes, git history, AGENTS.md).",
].join("\n");
export interface WorkspaceMemoryPatch {
  writes: Array<{ file: string; content: string }>;
  /** 追加到已有文件末尾。预览被截断的文件只能走这条路。 */
  appends: Array<{ file: string; content: string }>;
  deletes: string[];
  index?: string;
}

export function buildWorkspaceMemorySection(root: string, indexContent: string | null): string {
  const index = indexContent ? formatWorkspaceMemoryIndex(indexContent) : "";
  return [
    `${WORKSPACE_MEMORY_PROMPT_MARKER}\nYou have a persistent file-based workspace memory at \`${root}/\`.`,
    MEMORY_USAGE,
    index
      ? `Contents of MEMORY.md (loaded every session):\n${index}`
      : "MEMORY.md is empty, unreadable, or too large. New memories will appear here.",
  ].join("\n\n");
}

export function createWorkspaceMemoryExtension(input: {
  root: string;
  /** 记忆根所在的 workspace；相对路径按它解析。 */
  workspacePath: string;
  /** 每轮重新读项目开关；关闭时立刻停止注入，不必重开会话。 */
  enabled: boolean | (() => Promise<boolean>);
}): InlineExtension {
  const isEnabled = async () =>
    typeof input.enabled === "function" ? await input.enabled().catch(() => false) : input.enabled;
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      if (!(await isEnabled())) {
        delete event.systemPromptOptions.forceSystemPrompt;
        return;
      }
      const index = await readWorkspaceMemoryIndex(input.root);
      // 这个扩展必须最后注册：先让其它 handler 把 section 写进 systemPromptOptions，
      // 再用完整 prompt 追加记忆。只改 sections 时，部分 provider 会丢弃后续 system
      // 消息，模型实际看不到（lens/deepseek 实测如此）。
      const prompt = stripWorkspaceMemoryPrompt(event.systemPrompt);
      event.systemPromptOptions.forceSystemPrompt = `${prompt}\n\n${buildWorkspaceMemorySection(
        input.root,
        index,
      )}`;
    });
  };
}

/** 上一轮的 force prompt 已经带过记忆段；先截断再追加，防止重复累积。 */
function stripWorkspaceMemoryPrompt(prompt: string): string {
  const index = prompt.indexOf(WORKSPACE_MEMORY_PROMPT_MARKER);
  return index >= 0 ? prompt.slice(0, index).trimEnd() : prompt;
}

export async function readWorkspaceMemoryIndex(root: string): Promise<string | null> {
  const path = join(root, WORKSPACE_MEMORY_INDEX_FILE_NAME);
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    // 只防超大文件卡住注入；注入量由 formatWorkspaceMemoryIndex 的软上限控制。
    if (metadata.size > WORKSPACE_MEMORY_INDEX_READ_MAX_BYTES) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 索引注入预算：超行数或字符数就截断，并追加一句 WARNING 让模型自己压缩。
 *
 * 旧实现在超过 32 KiB 时直接返回 null，模型看到的是「索引是空的」——
 * 记忆明明存在却不可见，而且没有任何提示要求整理。截断 + WARNING 让膨胀变成
 * 模型下一轮能自己修的问题。
 */
export function formatWorkspaceMemoryIndex(content: string): string {
  const trimmed = stripIndexFrontmatter(content).trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const lineTruncated = lines.length > WORKSPACE_MEMORY_INDEX_MAX_LINES;
  const charTruncated = trimmed.length > WORKSPACE_MEMORY_INDEX_MAX_CHARS;
  if (!lineTruncated && !charTruncated) return trimmed;

  let truncated = lineTruncated
    ? lines.slice(0, WORKSPACE_MEMORY_INDEX_MAX_LINES).join("\n")
    : trimmed;
  if (truncated.length > WORKSPACE_MEMORY_INDEX_MAX_CHARS) {
    const lastNewline = truncated.lastIndexOf("\n", WORKSPACE_MEMORY_INDEX_MAX_CHARS);
    truncated = truncated.slice(
      0,
      lastNewline > 0 ? lastNewline : WORKSPACE_MEMORY_INDEX_MAX_CHARS,
    );
  }
  const size = lineTruncated
    ? `${lines.length} lines (limit ${WORKSPACE_MEMORY_INDEX_MAX_LINES})`
    : `${trimmed.length} chars (limit ${WORKSPACE_MEMORY_INDEX_MAX_CHARS})`;
  return `${truncated}\n\n> WARNING: MEMORY.md is ${size}; only part of it was loaded. Merge or delete stale entries and keep one line per memory.`;
}

/** 索引文件开头可能被手写 frontmatter；它不该占用注入预算。 */
function stripIndexFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end < 0 ? content : content.slice(end + 4);
}

/** 模型只返回 writes 时，从现有条目补一份索引，避免记忆永远不可见。 */
export async function rebuildWorkspaceMemoryIndex(root: string): Promise<string | null> {
  let entries;
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isWorkspaceMemoryItemFileName(entry.name)) continue;
    const content = await readFile(join(root, entry.name), "utf-8").catch(() => "");
    const { name, description } = parseWorkspaceMemoryFrontmatter(content);
    lines.push(
      formatWorkspaceMemoryPointerLine({
        fileName: entry.name,
        title: name || entry.name.slice(0, -".md".length),
        ...(description ? { description } : {}),
      }),
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析并校验模型返回的补丁；任何非法字段都让整次抽取失败。 */
export function parseWorkspaceMemoryPatch(text: string): WorkspaceMemoryPatch | null {
  const parsed = extractJsonObject(text);
  if (!isRecord(parsed)) return null;

  const writes: Array<{ file: string; content: string }> = [];
  if (parsed.writes !== undefined) {
    if (!Array.isArray(parsed.writes)) return null;
    for (const item of parsed.writes) {
      if (!isRecord(item)) return null;
      const file = typeof item.file === "string" ? item.file.trim() : "";
      const content = typeof item.content === "string" ? item.content : "";
      if (!isWorkspaceMemoryItemFileName(file)) return null;
      if (Buffer.byteLength(content, "utf-8") > WORKSPACE_MEMORY_MAX_ITEM_BYTES) return null;
      writes.push({ file, content });
    }
  }

  const deletes: string[] = [];
  if (parsed.deletes !== undefined) {
    if (!Array.isArray(parsed.deletes)) return null;
    for (const item of parsed.deletes) {
      const file = typeof item === "string" ? item.trim() : "";
      if (!isWorkspaceMemoryItemFileName(file)) return null;
      deletes.push(file);
    }
  }

  const appends: Array<{ file: string; content: string }> = [];
  if (parsed.appends !== undefined) {
    if (!Array.isArray(parsed.appends)) return null;
    for (const item of parsed.appends) {
      if (!isRecord(item)) return null;
      const file = typeof item.file === "string" ? item.file.trim() : "";
      const content = typeof item.content === "string" ? item.content : "";
      if (!isWorkspaceMemoryItemFileName(file)) return null;
      if (Buffer.byteLength(content, "utf-8") > WORKSPACE_MEMORY_MAX_ITEM_BYTES) return null;
      appends.push({ file, content });
    }
  }

  let index: string | undefined;
  if (parsed.index !== undefined) {
    if (typeof parsed.index !== "string") return null;
    // 超预算的索引不在这里判死：写入时改落紧凑重建索引，避免整次抽取白跑。
    if (Buffer.byteLength(parsed.index, "utf-8") > WORKSPACE_MEMORY_MAX_INDEX_BYTES) return null;
    index = parsed.index;
  }

  if (writes.length === 0 && appends.length === 0 && deletes.length === 0 && index === undefined) {
    return null;
  }
  return { writes, appends, deletes, ...(index !== undefined ? { index } : {}) };
}

/**
 * 返回被跳过的条目：截断文件禁整份写、append 超 64 KiB 的内容不落盘。
 * 静默跳过会让调用方以为整份已应用；调用方据此记 `warn`，并在“什么都没落盘”时不推游标。
 */
export async function applyWorkspaceMemoryPatch(
  root: string,
  patch: WorkspaceMemoryPatch,
  options: { expectedIndex?: string | null; truncatedFiles?: readonly string[] } = {},
): Promise<{ applied: number; skipped: string[] }> {
  await mkdir(root, { recursive: true });
  await assertWorkspaceMemoryRootTrusted(root);
  const skipped: string[] = [];
  let applied = 0;
  // 预览被截断的文件模型没看全，整份重写会把尾部内容抹掉；这类只能 appends。
  const truncated = new Set(options.truncatedFiles ?? []);
  for (const file of patch.writes) {
    if (truncated.has(file.file)) {
      skipped.push(`write:${file.file}`);
      continue;
    }
    await atomicWritePrivateTextFile(join(root, file.file), file.content);
    applied += 1;
  }
  for (const file of patch.appends) {
    const existing = await readFile(join(root, file.file), "utf-8").catch(() => null);
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    const next = `${existing ?? ""}${separator}${file.content}`;
    if (Buffer.byteLength(next, "utf-8") > WORKSPACE_MEMORY_MAX_ITEM_BYTES) {
      skipped.push(`append:${file.file}`);
      continue;
    }
    await atomicWritePrivateTextFile(join(root, file.file), next);
    applied += 1;
  }
  for (const file of patch.deletes) {
    await rm(join(root, file), { force: true });
    applied += 1;
  }
  // 索引写入：模型给的索引超出注入预算时不落盘，改用条目重建的紧凑索引。
  // 否则一次抽取就能把索引写成模型自己再也看不全的样子。
  const proposedIndex =
    patch.index !== undefined && !isWorkspaceMemoryIndexOverBudget(patch.index)
      ? patch.index
      : undefined;
  if (proposedIndex !== undefined) {
    // 模型读 index 与写回之间，主模型可能已经手工追加了指针行。
    // 当前值与抽取快照不一致时不用旧快照整份覆盖，但已经改过的文件仍要跟索引对账。
    if (options.expectedIndex !== undefined) {
      const current = await readWorkspaceMemoryIndex(root);
      if (current !== options.expectedIndex) {
        await reconcileWorkspaceMemoryIndex(root);
        return { applied, skipped };
      }
    }
    await atomicWritePrivateTextFile(join(root, WORKSPACE_MEMORY_INDEX_FILE_NAME), proposedIndex);
    applied += 1;
    // 模型漏写指针、或删文件没删指针时补上：否则新文件永远不注入，死链一直留着。
    await reconcileWorkspaceMemoryIndex(root);
    return { applied, skipped };
  }
  const current = await readWorkspaceMemoryIndex(root);
  if (patch.index !== undefined) {
    // 模型给的索引超预算：不落盘，改用条目重建的紧凑索引。
    const rebuilt =
      (await rebuildWorkspaceMemoryIndex(root)) ?? (current && current.trim() ? current : null);
    if (rebuilt) {
      await atomicWritePrivateTextFile(join(root, WORKSPACE_MEMORY_INDEX_FILE_NAME), rebuilt);
      applied += 1;
    }
  }
  // 只返回 writes / deletes 没给索引时，索引里既不会多出新文件的指针，
  // 也不会少掉已删文件的指针。落盘后统一对账一次（缺索引时按条目生成）。
  await reconcileWorkspaceMemoryIndex(root);
  return { applied, skipped };
}

/** 索引是否超出注入预算（行数或字符数）。 */
function isWorkspaceMemoryIndexOverBudget(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.split("\n").length > WORKSPACE_MEMORY_INDEX_MAX_LINES ||
    trimmed.length > WORKSPACE_MEMORY_INDEX_MAX_CHARS
  );
}
