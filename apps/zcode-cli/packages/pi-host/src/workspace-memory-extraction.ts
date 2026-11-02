import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  assertWorkspaceMemoryRootTrusted,
  isWorkspaceMemoryItemFileName,
} from "@zcode/shared/node";

/** 抽取 prompt 里最多带多少现有记忆 manifest，避免长历史项目把请求撑爆。 */
const WORKSPACE_MEMORY_MANIFEST_MAX_BYTES = 48 * 1024;
/** manifest 里每个文件只带前 N 行预览；正文靠实际写入，不靠模型背诵。 */
const WORKSPACE_MEMORY_PREVIEW_LINES = 30;
/** manifest 最多列多少个文件，剩下的只计数。 */
const WORKSPACE_MEMORY_MANIFEST_MAX_FILES = 200;

export interface WorkspaceMemoryManifestEntry {
  name: string;
  description?: string;
  preview: string;
  /** 预览被截断：模型看不到尾部，因此不允许整体重写这个文件。 */
  truncated: boolean;
  bytes: number;
  updatedAt: number;
}

function parseMemoryFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const block = match[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim();
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
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
      const { description } = parseMemoryFrontmatter(content);
      manifest.push({
        name: candidate.name,
        ...(description ? { description } : {}),
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
      const meta = `${entry.bytes} bytes, updated ${new Date(entry.updatedAt).toISOString()}`;
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
    '{"writes":[{"file":"kebab-case.md","content":"---\nname: ...\ndescription: ...\ntype: project\n---\n..."}],"appends":[{"file":"existing.md","content":"..."}],"deletes":["old.md"],"index":"- [Title](file.md) — hook\n"}',
    "Rules:",
    "- Omit keys you do not need. An empty update is fine.",
    "- `file` must be a lowercase .md filename, never MEMORY.md, no directories.",
    "- `writes` replaces a whole file. Only use it for new files, or for existing files shown without `truncated`.",
    "- `appends` adds text to the end of an existing file. Use it for files marked `truncated`, which you cannot see in full.",
    "- `index` is the complete new MEMORY.md body; one pointer line per memory, no content.",
    "- Keep each file under 64 KiB and the index under 200 lines.",
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

/** 从投影行里取本轮对话，供抽取 prompt 使用。 */
export function buildWorkspaceMemoryTranscript(
  rows: ReadonlyArray<{ kind: string; text?: string; turnId?: string }>,
): string {
  const lastTurnId = [...rows].reverse().find((row) => row.kind === "turnHeader")?.turnId;
  const selected = lastTurnId ? rows.filter((row) => row.turnId === lastTurnId) : rows;
  const lines: string[] = [];
  for (const row of selected) {
    if (row.kind === "userInput" && row.text?.trim()) {
      lines.push(`User: ${row.text.trim()}`);
    } else if (row.kind === "assistantText" && row.text?.trim()) {
      lines.push(`Assistant: ${row.text.trim()}`);
    }
  }
  return lines.join("\n\n");
}
