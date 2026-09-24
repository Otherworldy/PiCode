import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: Array<{
    path: string;
    additions: number;
    deletions: number;
    writeCount: number;
    toolNames: string[];
    patches: [];
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
    reason: "checkpoint_missing" | "checkpoint_unreadable" | "external_modified" | "file_read_failed";
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
type FileOp =
  | { kind: "edit"; path: string; edits: TextEdit[] }
  | { kind: "write"; path: string; content: string };
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

function parseTurn(rows: readonly ConversationRow[], turnId: string): ParsedTurn {
  const files = new Map<string, FileOp[]>();
  let bashCount = 0;
  for (const row of rows) {
    if (row.kind !== "toolCall" || row.turnId !== turnId || row.status !== "success") continue;
    if (row.toolName === "Bash") {
      bashCount += 1;
      continue;
    }
    if (row.toolName !== "Edit" && row.toolName !== "Write") continue;
    const args = parseArgs(row.inputText);
    const path = typeof args?.path === "string" ? args.path : "";
    const op: FileOp | null =
      row.toolName === "Write"
        ? typeof args?.content === "string"
          ? { kind: "write", path, content: args.content }
          : { kind: "write", path, content: "" }
        : { kind: "edit", path, edits: editsOf(args?.edits) ?? [] };
    const list = files.get(path) ?? [];
    list.push(op);
    files.set(path, list);
  }
  return { files, bashCount };
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
  const { files } = parseTurn(rows, turnId);
  const items = [];
  for (const [path, ops] of files) {
    if (!path) continue;
    let additions = 0;
    let deletions = 0;
    const toolNames = new Set<string>();
    for (const op of ops) {
      toolNames.add(op.kind === "edit" ? "Edit" : "Write");
      if (op.kind === "write") {
        additions += op.content.length === 0 ? 0 : op.content.split("\n").length;
        continue;
      }
      for (const edit of op.edits) {
        const delta = lineDelta(edit.oldText, edit.newText);
        additions += delta.additions;
        deletions += delta.deletions;
      }
    }
    items.push({
      path,
      additions,
      deletions,
      writeCount: ops.length,
      toolNames: [...toolNames],
      patches: [] as [],
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

export async function planTurnFileRewind(
  rows: readonly ConversationRow[],
  turnId: string,
  read: ReadTurnFile,
): Promise<FileRewindPlan> {
  const { files, bashCount } = parseTurn(rows, turnId);
  const ignoredFiles =
    bashCount > 0
      ? [{ operationCount: bashCount, path: "shell", reason: "bash_ignored" as const, toolNames: ["Bash"] }]
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
      // write 没有旧内容。内容仍等于这次写入时，退回就是删掉该文件。
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
