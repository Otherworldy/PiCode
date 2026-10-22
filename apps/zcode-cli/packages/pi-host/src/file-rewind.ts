import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { toolInputPath } from "./presentation.js";

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: Array<{
    path: string;
    additions: number;
    deletions: number;
    writeCount: number;
    toolNames: string[];
    patches: DiffHunk[];
  }>;
}

export interface FileRewindPreview {
  canApply: boolean;
  ignoredFiles: Array<{
    operationCount: number;
    path: string;
    reason: "bash_ignored";
    toolNames: string[];
  }>;
  safeFiles: Array<{
    action: "restore" | "delete";
    operationCount: number;
    path: string;
    toolNames: string[];
  }>;
  unsafeFiles: Array<{
    operationCount: number;
    path: string;
    reason:
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "external_modified"
      | "file_read_failed";
    toolNames: string[];
    message?: string;
  }>;
}

export interface FileRewindPlan {
  preview: FileRewindPreview;
  restores: Array<{ path: string; content: string }>;
  deletes: string[];
}

type TextEdit = { oldText: string; newText: string };
type FileDiffStat = { additions: number; deletions: number; lines: string[] };
type FileOp =
  | { kind: "edit"; path: string; edits: TextEdit[]; diff?: FileDiffStat }
  | { kind: "write"; path: string; content: string; overwrote: boolean };
type UnsafeReason = FileRewindPreview["unsafeFiles"][number]["reason"];

interface ParsedTurn {
  files: Map<string, FileOp[]>;
  bashCount: number;
}

function parseArgs(inputText: string): Record<string, unknown> | null {
  if (!inputText) return null;
  try {
    const parsed = JSON.parse(inputText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function editsOf(value: unknown): TextEdit[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const edits: TextEdit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.oldText !== "string" || typeof record.newText !== "string") return null;
    edits.push({ oldText: record.oldText, newText: record.newText });
  }
  return edits;
}

function fileDiffStat(
  row: Extract<ConversationRow, { kind: "toolCall" }>,
): FileDiffStat | undefined {
  const display = row.output?.display;
  if (!display || display.kind !== "file_diff") return undefined;
  const lines = display.structuredPatch[0]?.lines;
  return {
    additions: display.additions,
    deletions: display.deletions,
    lines: lines ? [...lines] : [],
  };
}

function parseTurn(rows: readonly ConversationRow[], turnIds: ReadonlySet<string>): ParsedTurn {
  const files = new Map<string, FileOp[]>();
  let bashCount = 0;
  for (const row of rows) {
    if (row.kind !== "toolCall" || !turnIds.has(row.turnId) || row.status !== "success") continue;
    if (row.toolName === "Bash") {
      bashCount += 1;
      continue;
    }
    if (row.toolName !== "Edit" && row.toolName !== "Write") continue;
    const args = parseArgs(row.inputText);
    const display = row.output?.display;
    const diff = fileDiffStat(row);
    const path =
      toolInputPath(row.inputText) || (display?.kind === "file_diff" ? display.filePath : "");
    const op: FileOp | null =
      row.toolName === "Write"
        ? {
            kind: "write",
            path,
            content: typeof args?.content === "string" ? args.content : "",
            // write 的 diff 带删除行 = 它覆盖了已有内容。Pi 的 write 没有 before 快照，
            // 这种撤销只能删文件，会把锚点之前就存在的文件一起删掉，必须判为不可安全撤销。
            overwrote: (diff?.deletions ?? 0) > 0,
          }
        : { kind: "edit", path, edits: editsOf(args?.edits) ?? [], ...(diff ? { diff } : {}) };
    const list = files.get(path) ?? [];
    list.push(op);
    files.set(path, list);
  }
  return { files, bashCount };
}

function splitDiffLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function fragmentHunk(before: string, after: string): DiffHunk | null {
  if (before === after) return null;
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);
  return {
    oldStart: oldLines.length === 0 ? 0 : 1,
    oldLines: oldLines.length,
    newStart: newLines.length === 0 ? 0 : 1,
    newLines: newLines.length,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  };
}

function lineDelta(before: string, after: string): { additions: number; deletions: number } {
  const count = (lines: string[]) => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const left = count(before.split("\n"));
  const right = count(after.split("\n"));
  let additions = 0;
  let deletions = 0;
  for (const line of new Set([...left.keys(), ...right.keys()])) {
    const delta = (right.get(line) ?? 0) - (left.get(line) ?? 0);
    if (delta > 0) additions += delta;
    else deletions += -delta;
  }
  return { additions, deletions };
}

function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/** Pi 的一次 edit 全部打在原文上。退回时每个 newText 必须在当前文件里只出现一次。 */
export function undoEdits(content: string, edits: readonly TextEdit[]): string | null {
  const ending = content.includes("\r\n") ? "\r\n" : "\n";
  let next = content.replaceAll("\r\n", "\n");
  const normalized = edits.map((edit) => ({
    oldText: edit.oldText.replaceAll("\r\n", "\n"),
    newText: edit.newText.replaceAll("\r\n", "\n"),
  }));
  for (const edit of normalized) {
    if (edit.newText === edit.oldText) continue;
    if (!edit.newText || occurrences(next, edit.newText) !== 1) return null;
  }
  for (const edit of [...normalized].reverse()) {
    if (edit.newText === edit.oldText) continue;
    const at = next.indexOf(edit.newText);
    if (at < 0) return null;
    next = next.slice(0, at) + edit.oldText + next.slice(at + edit.newText.length);
  }
  return ending === "\r\n" ? next.replaceAll("\n", "\r\n") : next;
}

export function summarizeTurnFileChanges(
  rows: readonly ConversationRow[],
  turnId: string,
): TurnFileChangeSummary | null {
  const { files } = parseTurn(rows, new Set([turnId]));
  const items = [];
  for (const [path, ops] of files) {
    if (!path) continue;
    let additions = 0;
    let deletions = 0;
    const toolNames = new Set<string>();
    // 审查按钮只在 patches 非空时可点。这里以前把 patches 固定成空数组，
    // 加减行有了按钮也一直是灰的。用同一次 edit/write 入参拼 hunk。
    // ponytail: write 覆盖没有旧内容，只能当成全部新增；要对比旧文件得走 checkpoint diff。
    const patches: DiffHunk[] = [];
    for (const op of ops) {
      toolNames.add(op.kind === "edit" ? "Edit" : "Write");
      if (op.kind === "write") {
        additions += op.content.length === 0 ? 0 : op.content.split("\n").length;
        const hunk = fragmentHunk("", op.content);
        if (hunk) patches.push(hunk);
        continue;
      }
      let fragAdd = 0;
      let fragDel = 0;
      for (const edit of op.edits) {
        const delta = lineDelta(edit.oldText, edit.newText);
        fragAdd += delta.additions;
        fragDel += delta.deletions;
        const hunk = fragmentHunk(edit.oldText, edit.newText);
        if (hunk) patches.push(hunk);
      }
      // 入参被截短时片段是 0。工具结果上的 diff 才是这次调用真正改了多少行。
      if (fragAdd + fragDel === 0 && op.diff && op.diff.additions + op.diff.deletions > 0) {
        additions += op.diff.additions;
        deletions += op.diff.deletions;
        if (op.diff.lines.length > 0) {
          patches.push({
            oldStart: 1,
            oldLines: op.diff.deletions,
            newStart: 1,
            newLines: op.diff.additions,
            lines: op.diff.lines,
          });
        }
      } else {
        additions += fragAdd;
        deletions += fragDel;
      }
    }
    items.push({
      path,
      additions,
      deletions,
      writeCount: ops.length,
      toolNames: [...toolNames],
      patches,
    });
  }
  if (items.length === 0) return null;
  items.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

export type ReadTurnFile = (
  path: string,
) => Promise<{ content: string } | { missing: true } | { error: string }>;

/**
 * anchor turn 及其之后所有 turn 的 id。锚点不在窗口里时只撤它自己，
 * 避免窗口裁剪把整段后缀当成空集合。
 */
export function suffixTurnIds(rows: readonly ConversationRow[], anchorTurnId: string): string[] {
  const turnIds = rows.filter((row) => row.kind === "turnHeader").map((row) => row.turnId);
  const index = turnIds.indexOf(anchorTurnId);
  if (index < 0) return [anchorTurnId];
  return turnIds.slice(index);
}

export async function planTurnFileRewind(
  rows: readonly ConversationRow[],
  turnId: string,
  read: ReadTurnFile,
): Promise<FileRewindPlan> {
  return planFileRewind(rows, new Set([turnId]), read);
}

/**
 * 回退到此处：撤销 anchor turn 及其之后所有 turn 的文件改动。
 * 多个 turn 的写操作按事件顺序合并后从新到旧撤销，同一文件以最早的状态为准；
 * 逐 turn 各算一遍会拿「当前磁盘」去校验更早的 checkpoint，得到错误的 unsafe。
 */
export async function planSuffixFileRewind(
  rows: readonly ConversationRow[],
  anchorTurnId: string,
  read: ReadTurnFile,
): Promise<FileRewindPlan> {
  return planFileRewind(rows, new Set(suffixTurnIds(rows, anchorTurnId)), read);
}

async function planFileRewind(
  rows: readonly ConversationRow[],
  turnIds: ReadonlySet<string>,
  read: ReadTurnFile,
): Promise<FileRewindPlan> {
  const { files, bashCount } = parseTurn(rows, turnIds);
  const ignoredFiles =
    bashCount > 0
      ? [
          {
            operationCount: bashCount,
            path: "shell",
            reason: "bash_ignored" as const,
            toolNames: ["Bash"],
          },
        ]
      : [];
  const safeFiles: FileRewindPreview["safeFiles"] = [];
  const unsafeFiles: FileRewindPreview["unsafeFiles"] = [];
  const restores: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];

  for (const [path, ops] of files) {
    const toolNames = [...new Set(ops.map((op) => (op.kind === "edit" ? "Edit" : "Write")))];
    const base = { operationCount: ops.length, path: path || "(edit)", toolNames };
    if (!path || ops.some((op) => op.kind === "edit" && op.edits.length === 0)) {
      unsafeFiles.push({ ...base, reason: "checkpoint_unreadable" });
      continue;
    }
    const current = await read(path);
    if ("error" in current) {
      unsafeFiles.push({ ...base, reason: "file_read_failed", message: current.error });
      continue;
    }
    if ("missing" in current) {
      unsafeFiles.push({ ...base, reason: "external_modified" });
      continue;
    }
    let content: string | null = current.content;
    let reason: UnsafeReason | null = null;
    for (const op of [...ops].reverse()) {
      if (op.kind === "edit") {
        if (content === null) {
          reason = "checkpoint_missing";
          break;
        }
        const undone = undoEdits(content, op.edits);
        if (undone === null) {
          reason = "external_modified";
          break;
        }
        content = undone;
        continue;
      }
      if (content === null || !sameFileText(content, op.content)) {
        reason = "external_modified";
        break;
      }
      if (op.overwrote) {
        // 覆盖已有文件的 write 没有旧内容可恢复；退回成删除会连锚点前的文件一起删掉。
        reason = "checkpoint_missing";
        break;
      }
      // 新建文件的 write：内容仍等于这次写入时，退回就是删掉该文件。
      content = null;
    }
    if (reason) {
      unsafeFiles.push({ ...base, reason });
      continue;
    }
    if (content === null) {
      safeFiles.push({ ...base, action: "delete" });
      deletes.push(path);
      continue;
    }
    safeFiles.push({ ...base, action: "restore" });
    restores.push({ path, content });
  }

  safeFiles.sort((left, right) => left.path.localeCompare(right.path));
  unsafeFiles.sort((left, right) => left.path.localeCompare(right.path));
  const canApply = safeFiles.length > 0 && unsafeFiles.length === 0;
  return {
    preview: { canApply, ignoredFiles, safeFiles, unsafeFiles },
    restores: canApply ? restores : [],
    deletes: canApply ? deletes : [],
  };
}

function sameFileText(left: string, right: string): boolean {
  return left.replaceAll("\r\n", "\n") === right.replaceAll("\r\n", "\n");
}
