import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  atomicWritePrivateTextFile,
  isWorkspaceMemoryItemFileName,
  isWorkspaceMemoryMarkdownTarget,
  normalizeWorkspaceMemoryItem,
  reconcileWorkspaceMemoryIndex,
} from "@zcode/shared/node";

/**
 * 主模型直接写下的记忆文件：补齐 frontmatter 契约，并把索引指针行补上。
 *
 * 直接写入是主路径，但模型不守字段契约（实测写 `type: convention`、漏掉
 * `category` / `source` / `confirmed` / `lastConfirmed`），也不总会补 `MEMORY.md`。
 * 解析宽容只能保证不丢记忆；索引行、分类展示和过期判定都要规范值，所以在写入后归一。
 * 返回被改写的文件名，未改写时返回 null。
 */
export async function normalizeWorkspaceMemoryWrite(input: {
  workspacePath: string;
  memoryRoot: string;
  target: string;
  today?: string;
}): Promise<string | null> {
  const target = isAbsolute(input.target)
    ? input.target
    : resolve(input.workspacePath, input.target);
  const fileName = basename(target);
  // 索引文件由对账维护，不在这里补 frontmatter。
  if (!isWorkspaceMemoryItemFileName(fileName)) return null;
  // 顺带挡掉符号链接与不可信的目录。
  if (!(await isWorkspaceMemoryMarkdownTarget(input.workspacePath, target))) return null;
  const content = await readFile(target, "utf-8").catch(() => null);
  if (content === null) return null;
  const normalized = normalizeWorkspaceMemoryItem(content, {
    fileName,
    ...(input.today !== undefined ? { today: input.today } : {}),
  });
  if (normalized.changed) {
    await atomicWritePrivateTextFile(target, normalized.content);
  }
  // 文件与索引是两条写入路径：模型漏了指针行时，这里补上，否则新记忆永远不注入。
  // 即使文件本身已经合规（`changed === false`）也要跑一次对账：合规的新文件同样
  // 可能没进索引，对账幂等，已存在指针时不会写盘。
  await reconcileWorkspaceMemoryIndex(input.memoryRoot);
  return normalized.changed ? fileName : null;
}
