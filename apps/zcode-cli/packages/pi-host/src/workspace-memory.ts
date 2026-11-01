import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  WORKSPACE_MEMORY_INDEX_FILE_NAME,
  WORKSPACE_MEMORY_MAX_INDEX_BYTES,
  WORKSPACE_MEMORY_MAX_ITEM_BYTES,
  assertWorkspaceMemoryRootTrusted,
  atomicWritePrivateTextFile,
  isWorkspaceMemoryItemFileName,
} from "@zcode/shared/node";

/** 记忆段在完整 prompt 里的起始标记；每轮先剪掉旧段，避免 force prompt 越积越长。 */
const WORKSPACE_MEMORY_PROMPT_MARKER = "<!-- zcode:workspace-memory -->";

/** 抽取 prompt 里最多带多少现有记忆正文，避免长历史项目把请求撑爆。 */
const WORKSPACE_MEMORY_PROMPT_MAX_BYTES = 256 * 1024;

const MEMORY_USAGE = [
  "This is your persistent workspace memory. Each memory is one Markdown file holding one fact.",
  "Write memories with the Write tool directly into this directory; it already exists.",
  "After writing a file, add one pointer line to `MEMORY.md`: `- [Title](file.md) — hook`.",
  "`MEMORY.md` is an index only. Keep one line per memory and never put memory content there.",
  "Check existing files before adding a duplicate; update or delete memories that turn out to be wrong.",
  "Do not save what the repository already records (code structure, past fixes, git history, AGENTS.md).",
].join("\n");

export interface WorkspaceMemoryExtractionFile {
  name: string;
  content: string;
}

export interface WorkspaceMemoryPatch {
  writes: Array<{ file: string; content: string }>;
  deletes: string[];
  index?: string;
}

export function buildWorkspaceMemorySection(root: string, indexContent: string | null): string {
  const index = indexContent?.trim();
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
  /** 每轮重新读项目开关；关闭时立刻停止注入，不必重开会话。 */
  enabled: boolean | (() => Promise<boolean>);
}): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const enabled =
        typeof input.enabled === "function"
          ? await input.enabled().catch(() => false)
          : input.enabled;
      if (!enabled) {
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
    if (metadata.size > WORKSPACE_MEMORY_MAX_INDEX_BYTES) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
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
    const { name, description } = parseMemoryFrontmatter(content);
    const title = name || entry.name.slice(0, -".md".length);
    const hook = description?.replace(/\s+/g, " ").trim();
    lines.push(hook ? `- [${title}](${entry.name}) — ${hook}` : `- [${title}](${entry.name})`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

export async function readWorkspaceMemoryFiles(
  root: string,
): Promise<WorkspaceMemoryExtractionFile[]> {
  let entries;
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: WorkspaceMemoryExtractionFile[] = [];
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!isWorkspaceMemoryItemFileName(entry.name)) continue;
    try {
      const path = join(root, entry.name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > WORKSPACE_MEMORY_MAX_ITEM_BYTES) continue;
      if (totalBytes + metadata.size > WORKSPACE_MEMORY_PROMPT_MAX_BYTES) break;
      totalBytes += metadata.size;
      files.push({ name: entry.name, content: await readFile(path, "utf-8") });
    } catch {
      // 并发删除或不可读：本次抽取跳过这个文件。
    }
  }
  return files;
}

export function buildWorkspaceMemoryExtractionPrompt(input: {
  transcript: string;
  index: string | null;
  files: readonly WorkspaceMemoryExtractionFile[];
}): string {
  const existing = input.files
    .map((file) => `<file name="${file.name}">\n${file.content}\n</file>`)
    .join("\n");
  return [
    "You maintain the persistent workspace memory for this project.",
    "Only use the conversation below. Do not investigate the repository, run tools, or verify code.",
    "Update existing memories instead of duplicating them. Delete memories that are now wrong.",
    "Return ONLY a JSON object with this shape:",
    '{"writes":[{"file":"kebab-case.md","content":"---\\nname: ...\\ndescription: ...\\ntype: project\\n---\\n..."}],"deletes":["old.md"],"index":"- [Title](file.md) — hook\\n"}',
    "Rules:",
    "- Omit keys you do not need. An empty update is fine.",
    "- `file` must be a lowercase .md filename, never MEMORY.md, no directories.",
    "- `index` is the complete new MEMORY.md body; one pointer line per memory, no content.",
    "- Keep each file under 64 KiB and the index under 32 KiB.",
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

  let index: string | undefined;
  if (parsed.index !== undefined) {
    if (typeof parsed.index !== "string") return null;
    if (Buffer.byteLength(parsed.index, "utf-8") > WORKSPACE_MEMORY_MAX_INDEX_BYTES) return null;
    index = parsed.index;
  }

  if (writes.length === 0 && deletes.length === 0 && index === undefined) return null;
  return { writes, deletes, ...(index !== undefined ? { index } : {}) };
}

export async function applyWorkspaceMemoryPatch(
  root: string,
  patch: WorkspaceMemoryPatch,
  options: { expectedIndex?: string | null } = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await assertWorkspaceMemoryRootTrusted(root);
  for (const file of patch.writes) {
    await atomicWritePrivateTextFile(join(root, file.file), file.content);
  }
  for (const file of patch.deletes) {
    await rm(join(root, file), { force: true });
  }
  if (patch.index !== undefined) {
    // 模型读 index 与写回之间，主模型可能已经手工追加了指针行。
    // 当前值与抽取快照不一致时只保留并发写入，不用旧快照整份覆盖。
    if (options.expectedIndex !== undefined) {
      const current = await readWorkspaceMemoryIndex(root);
      if (current !== options.expectedIndex) return;
    }
    await atomicWritePrivateTextFile(join(root, WORKSPACE_MEMORY_INDEX_FILE_NAME), patch.index);
  } else {
    const current = await readWorkspaceMemoryIndex(root);
    if (current === null || current.trim() === "") {
      const rebuilt = await rebuildWorkspaceMemoryIndex(root);
      if (rebuilt) {
        await atomicWritePrivateTextFile(join(root, WORKSPACE_MEMORY_INDEX_FILE_NAME), rebuilt);
      }
    }
  }
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
