import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  WORKSPACE_MEMORY_CATEGORIES,
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  WORKSPACE_MEMORY_SOURCES,
  WORKSPACE_MEMORY_TYPES,
  assertWorkspaceMemoryRootTrusted,
  isWorkspaceMemoryItemFileName,
  parseWorkspaceMemoryFrontmatter,
  type WorkspaceMemoryCategory,
} from "@zcode/shared/node";

/** 单次抽取携带的对话字符上限：超出时丢最早的轮次，保住最近的事实。 */
export const WORKSPACE_MEMORY_TRANSCRIPT_MAX_CHARS = 24_000;
/** 抽取 prompt 里最多带多少现有记忆 manifest，避免长历史项目把请求撑爆。 */
const WORKSPACE_MEMORY_MANIFEST_MAX_BYTES = 48 * 1024;
/** manifest 里每个文件只带前 N 行预览；正文靠实际写入，不靠模型背诵。 */
const WORKSPACE_MEMORY_PREVIEW_LINES = 30;
/** manifest 最多列多少个文件，剩下的只计数。 */
const WORKSPACE_MEMORY_MANIFEST_MAX_FILES = 200;

export interface WorkspaceMemoryManifestEntry {
  name: string;
  description?: string;
  /** 主题分类：抽取模型据此判断该并到哪个文件，而不是每类各写一条。 */
  category: WorkspaceMemoryCategory;
  preview: string;
  /** 预览被截断：模型看不到尾部，因此不允许整体重写这个文件。 */
  truncated: boolean;
  bytes: number;
  updatedAt: number;
}

/**
 * 抽取输入用的 manifest：文件名 + description + 前 30 行预览。
 */
export async function readWorkspaceMemoryManifest(
  root: string,
): Promise<WorkspaceMemoryManifestEntry[]> {
  let entries;
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Array<{ name: string; path: string; updatedAt: number; bytes: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!isWorkspaceMemoryItemFileName(entry.name)) continue;
    try {
      const path = join(root, entry.name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > WORKSPACE_MEMORY_MAX_ITEM_BYTES) continue;
      candidates.push({
        name: entry.name,
        path,
        updatedAt: metadata.mtimeMs,
        bytes: metadata.size,
      });
    } catch {
      // 并发删除或不可读：本次抽取跳过这个文件。
    }
  }
  // 最近改过的排在前面：预算不够时先展开它们。
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);

  const manifest: WorkspaceMemoryManifestEntry[] = [];
  let totalBytes = 0;
  for (const candidate of candidates.slice(0, WORKSPACE_MEMORY_MANIFEST_MAX_FILES)) {
    try {
      const content = await readFile(candidate.path, "utf-8");
      const lines = content.split("\n");
      const truncated = lines.length > WORKSPACE_MEMORY_PREVIEW_LINES;
      const preview = truncated
        ? lines.slice(0, WORKSPACE_MEMORY_PREVIEW_LINES).join("\n")
        : content;
      if (totalBytes + preview.length > WORKSPACE_MEMORY_MANIFEST_MAX_BYTES) break;
      totalBytes += preview.length;
      const { description, category } = parseWorkspaceMemoryFrontmatter(content);
      manifest.push({
        name: candidate.name,
        ...(description ? { description } : {}),
        category,
        preview,
        truncated,
        bytes: candidate.bytes,
        updatedAt: candidate.updatedAt,
      });
    } catch {
      // 同上。
    }
  }
  return manifest;
}

export interface WorkspaceMemoryExtractionRow {
  kind: string;
  turnId?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  inputText?: string;
  origin?: string;
}

/** 少于 3 个词的轮次（「继续」「好的」）不值得为它跑一次抽取。 */
const WORKSPACE_MEMORY_MIN_USER_WORDS = 3;

/** 主模型本轮已经写过记忆：抽取再写一遍就是同一事实的两份。 */
export function containsDirectWorkspaceMemoryWrite(
  rows: readonly WorkspaceMemoryExtractionRow[],
  root: string,
): boolean {
  const normalizedRoot = normalizeForCompare(root);
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    if (row.toolName !== "Write" && row.toolName !== "Edit") continue;
    const target = toolCallPath(row);
    if (!target) continue;
    const resolved = normalizeForCompare(isAbsolute(target) ? target : join(root, target));
    if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${sep}`)) return true;
  }
  return false;
}

/** 本轮是否有值得记住的用户输入。工具回执、后台结果、合成消息都不算。 */
export function containsEligibleWorkspaceMemoryUserProse(
  rows: readonly WorkspaceMemoryExtractionRow[],
): boolean {
  for (const row of rows) {
    if (row.kind !== "userInput") continue;
    if (row.origin !== undefined && row.origin !== "realUser" && row.origin !== "guided") continue;
    if (countProseWords(row.text ?? "") >= WORKSPACE_MEMORY_MIN_USER_WORDS) return true;
  }
  return false;
}

/**
 * CJK 没有词边界，按空白分词会把一整句中文算成 1 个词。
 * 这里把每个 CJK 字符算一个「词」，其余按空白分词。
 */
function countProseWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjk = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu)?.length ?? 0;
  const latin = trimmed
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean).length;
  return cjk + latin;
}

function toolCallPath(row: WorkspaceMemoryExtractionRow): string {
  if (isRecord(row.input)) {
    const value = row.input.path ?? row.input.file_path;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (!row.inputText?.includes("{")) return "";
  try {
    const parsed = JSON.parse(row.inputText) as unknown;
    if (!isRecord(parsed)) return "";
    const value = parsed.path ?? parsed.file_path;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function buildWorkspaceMemoryExtractionPrompt(input: {
  transcript: string;
  index: string | null;
  manifest: readonly WorkspaceMemoryManifestEntry[];
}): string {
  const existing = input.manifest
    .map((entry) => {
      const meta = `${entry.bytes} bytes, ${entry.category}, updated ${new Date(entry.updatedAt).toISOString()}`;
      const head = entry.truncated
        ? `### ${entry.name} (truncated, ${meta})`
        : `### ${entry.name} (${meta})`;
      const description = entry.description ? `\ndescription: ${entry.description}` : "";
      return `${head}${description}\n${entry.preview}`;
    })
    .join("\n\n");
  return [
    "You maintain the persistent workspace memory for this project.",
    "Only use the conversation below. Do not investigate the repository, run tools, or verify code.",
    "Update existing memories instead of duplicating them. Delete memories that are now wrong.",
    "Return ONLY a JSON object with this shape:",
    '{"writes":[{"file":"kebab-case.md","content":"---\\nname: ...\\ndescription: ...\\ncategory: project\\ntype: constraint\\nsource: user\\nconfirmed: true\\nlastConfirmed: 2026-02-14\\n---\\n..."}],"appends":[{"file":"existing.md","content":"..."}],"deletes":["old.md"],"index":"- [Title](file.md) — hook\\n"}',
    "Rules:",
    "- Omit keys you do not need. An empty update is fine.",
    "- `file` must be a lowercase .md filename, never MEMORY.md, no directories.",
    "- `writes` replaces a whole file. Only use it for new files, or for existing files shown without `truncated`.",
    "- `appends` adds text to the end of an existing file. Use it for files marked `truncated`, which you cannot see in full.",
    "- `index` is the complete new MEMORY.md body; one pointer line per memory, no content.",
    "- Keep each file under 64 KiB and the index under 200 lines.",
    "- Every `writes` frontmatter must carry: name, description, category, type, source, confirmed, lastConfirmed.",
    `- category: one of ${WORKSPACE_MEMORY_CATEGORIES.join(" | ")} — the topic. Reuse the file already in that topic instead of making a second one.`,
    `- type: one of ${WORKSPACE_MEMORY_TYPES.join(" | ")} — preference/constraint came from the user, decision records why, fact is everything else.`,
    `- source: one of ${WORKSPACE_MEMORY_SOURCES.join(" | ")} — who this came from, not what it is about.`,
    "- confirmed: true only when the user said it explicitly; a guess from you stays false.",
    "- lastConfirmed: today's date (YYYY-MM-DD). Refresh it whenever you rewrite or re-confirm an existing memory; stale memories get expired.",
    "- expires: optional YYYY-MM-DD, only for facts that really stop being true on a date.",
    "Do NOT write:",
    "- transient task state: current step, progress, one-off command output, temp branch/port/process;",
    "- anything the repository already records: layout, dependency versions, git history, rules already in AGENTS.md;",
    "- session-local context: which file just changed, the error just fixed, the question awaiting the user.",
    "Self-check: if it will not still be true next week, or it takes more than one sentence, do not write it.",
    "",
    `<current_index>\n${input.index ?? "(empty)"}\n</current_index>`,
    existing
      ? `<current_files>\n${existing}\n</current_files>`
      : "<current_files>(none)</current_files>",
    "",
    "<conversation>",
    input.transcript,
    "</conversation>",
  ].join("\n");
}

/** 投影窗口内的 turn 顺序，用于给抽取游标定位。 */
export function listWorkspaceMemoryTurnIds(
  rows: ReadonlyArray<{ kind: string; turnId?: string }>,
): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.turnId) continue;
    if (ids[ids.length - 1] === row.turnId) continue;
    ids.push(row.turnId);
  }
  return ids;
}

/** 窗口里最后一个 turn 的 id，抽取成功后用它推进游标。 */
export function lastWorkspaceMemoryTurnId(
  rows: ReadonlyArray<{ kind: string; turnId?: string }>,
): string | undefined {
  return listWorkspaceMemoryTurnIds(rows).at(-1);
}

/**
 * 取「上次抽取之后」的全部对话，供抽取 prompt 使用。
 *
 * 抽取不是每轮都跑（3 轮 / 10 分钟闸门），所以要覆盖自上次抽取以来的所有 turn；
 * 只喂最后一轮会把中间轮次里用户交代的规则永久漏掉。窗口滚过游标时退化为整窗重抽。
 */
export function buildWorkspaceMemoryTranscript(
  rows: ReadonlyArray<{ kind: string; text?: string; turnId?: string }>,
  options: { afterTurnId?: string; maxChars?: number } = {},
): string {
  const turnIds = listWorkspaceMemoryTurnIds(rows);
  const cursorIndex = options.afterTurnId === undefined ? -1 : turnIds.indexOf(options.afterTurnId);
  const lines: string[] = [];
  for (const row of rows) {
    if (cursorIndex >= 0 && row.turnId !== undefined) {
      const index = turnIds.indexOf(row.turnId);
      // 游标之前的 turn 已经抽过；游标不在窗口里（index 为 -1）时整窗重抽。
      if (index >= 0 && index <= cursorIndex) continue;
    }
    if (row.kind === "userInput" && row.text?.trim()) {
      lines.push(`User: ${row.text.trim()}`);
    } else if (row.kind === "assistantText" && row.text?.trim()) {
      lines.push(`Assistant: ${row.text.trim()}`);
    }
  }
  const maxChars = options.maxChars ?? WORKSPACE_MEMORY_TRANSCRIPT_MAX_CHARS;
  const transcript = lines.join("\n\n");
  if (transcript.length <= maxChars) return transcript;
  // 从头部裁：越靠后的轮次越接近当前事实。
  return `…(earlier turns omitted)\n\n${transcript.slice(transcript.length - maxChars)}`;
}
