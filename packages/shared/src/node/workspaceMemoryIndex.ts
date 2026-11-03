import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWritePrivateTextFile } from "./privateFilePersistence.js";
import {
  WORKSPACE_MEMORY_INDEX_FILE_NAME,
  WORKSPACE_MEMORY_MAX_INDEX_BYTES,
  assertWorkspaceMemoryRootTrusted,
  isWorkspaceMemoryFileName,
  isWorkspaceMemoryItemFileName,
  parseWorkspaceMemoryFrontmatter,
  resolveWorkspaceMemoryRoot,
} from "./workspaceMemory.js";

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 索引里的一行指针：`- [Title](file.md) — hook`。 */
export function formatWorkspaceMemoryPointerLine(input: {
  fileName: string;
  title: string;
  description?: string;
}): string {
  const hook = input.description?.replace(/\s+/g, " ").trim();
  return hook
    ? `- [${input.title}](${input.fileName}) — ${hook}`
    : `- [${input.title}](${input.fileName})`;
}

const MEMORY_POINTER_TARGET = /\]\(([^)\s]+)\)/;

/**
 * 索引与文件对账：剔除指向已不存在文件的指针行，再给磁盘上存在但索引里没有的条目
 * 按 frontmatter 补一行指针。
 *
 * 索引与文件是两条独立写入路径（抽取、主模型、UI 编辑各写一份），不对账就会产生
 * 永不注入的孤儿文件，以及模型下一轮还能看到的死链接。索引缺失但已有条目时
 * 按条目生成索引：UI 新建的第一条记忆也得能进注入；空白项目仍不会被凭空建出
 * 一个 MEMORY.md。
 */
export async function reconcileWorkspaceMemoryIndex(memoryRoot: string): Promise<string | null> {
  const indexPath = join(memoryRoot, WORKSPACE_MEMORY_INDEX_FILE_NAME);
  const existing = await lstat(indexPath).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) return null;
  const hadIndex = existing !== null;
  const text = hadIndex ? await readFile(indexPath, "utf-8").catch(() => null) : "";
  if (text === null) return null;

  const entries = await readdir(memoryRoot, { withFileTypes: true }).catch(() => []);
  const itemNames = new Set(
    entries
      .filter((entry) => entry.isFile() && isWorkspaceMemoryItemFileName(entry.name))
      .map((entry) => entry.name),
  );

  const referenced = new Set<string>();
  const keptLines: string[] = [];
  for (const line of hadIndex ? text.split("\n") : []) {
    const target = MEMORY_POINTER_TARGET.exec(line)?.[1];
    if (target === undefined) {
      keptLines.push(line);
      continue;
    }
    const fileName = target.replace(/^\.\//, "");
    if (!isWorkspaceMemoryItemFileName(fileName)) {
      // 目录外的链接、非条目链接（例如 README）原样保留。
      keptLines.push(line);
      continue;
    }
    if (!itemNames.has(fileName)) continue; // 文件已删：指针行跟着消失
    referenced.add(fileName);
    keptLines.push(line);
  }

  const appended: string[] = [];
  for (const fileName of [...itemNames].sort((left, right) => left.localeCompare(right, "en"))) {
    if (referenced.has(fileName)) continue;
    const content = await readFile(join(memoryRoot, fileName), "utf-8").catch(() => "");
    const { name, description } = parseWorkspaceMemoryFrontmatter(content);
    const line = formatWorkspaceMemoryPointerLine({
      fileName,
      title: name || fileName.slice(0, -".md".length),
      ...(description ? { description } : {}),
    });
    // 追加也受索引写入上限约束：对账不能把索引撑过预算。
    const candidate = [...keptLines, ...appended, line].join("\n");
    if (Buffer.byteLength(candidate, "utf-8") > WORKSPACE_MEMORY_MAX_INDEX_BYTES) break;
    appended.push(line);
  }

  let next = [...keptLines, ...appended].join("\n");
  if (appended.length > 0 && !next.endsWith("\n")) next += "\n";
  if (!hadIndex && appended.length === 0) return null;
  if (hadIndex && next === text) return text;
  await atomicWritePrivateTextFile(indexPath, next);
  return next;
}

/** 判断 Write/Edit 的目标是否是可自动放行的记忆 Markdown。 */
export async function isWorkspaceMemoryMarkdownTarget(
  workspacePath: string,
  filePath: string,
): Promise<boolean> {
  const root = resolveWorkspaceMemoryRoot(workspacePath);
  const target = resolve(workspacePath, filePath);
  if (normalizePathForCompare(dirname(target)) !== normalizePathForCompare(root)) return false;
  if (!isWorkspaceMemoryFileName(basename(target))) return false;
  try {
    await assertWorkspaceMemoryRootTrusted(root);
    const targetMetadata = await lstat(target).catch(() => null);
    if (targetMetadata && (!targetMetadata.isFile() || targetMetadata.isSymbolicLink())) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
