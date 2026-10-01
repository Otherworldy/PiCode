import { readPiJsonl } from "./jsonl-history.js";
import type {
  PiHostEvent,
  PiSessionPort,
  PiSessionTreeNode,
  SessionResumeRequest,
  SessionResumeResult,
} from "./types.js";

type TreeEntry = {
  id: string;
  parentId?: string | null;
  type?: string;
  summary?: unknown;
  message?: { role?: string; content?: unknown; id?: string; toolName?: string };
};

type TreeNode = {
  entry: TreeEntry;
  children: TreeNode[];
  label?: string;
};

export type SessionTreeSource = {
  getLeafId(): string | null;
  getBranch(): Array<{ id: string }>;
  getTree(): TreeNode[];
  getEntry(id: string): unknown;
  getEntries(): TreeEntry[];
  buildContextEntries(): unknown[];
  appendLabelChange(targetId: string, label: string | undefined): string;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function roleOf(entry: TreeEntry): PiSessionTreeNode["role"] {
  if (entry.type === "branch_summary") return "summary";
  if (entry.type === "compaction") return "compaction";
  const role = entry.message?.role;
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "toolResult" || role === "tool") return "tool";
  return "other";
}

function previewOf(entry: TreeEntry): string {
  if (typeof entry.summary === "string") return clip(entry.summary);
  const message = entry.message;
  if (!message) return entry.type ?? "";
  if (message.role === "toolResult" || message.role === "tool") {
    return clip(message.toolName || "tool");
  }
  return clip(textOf(message.content));
}

export function readSessionTree(source: Pick<SessionTreeSource, "getLeafId" | "getBranch" | "getTree">): PiSessionTreeNode[] {
  const leafId = source.getLeafId();
  const active = new Set(source.getBranch().map((entry) => entry.id));
  const out: PiSessionTreeNode[] = [];
  // ponytail: 迭代压平。父链超过约 1 万层时递归会 Maximum call stack size exceeded。
  const stack: Array<{ node: TreeNode; depth: number }> = [];
  const roots = source.getTree();
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const node = roots[index];
    if (node) stack.push({ node, depth: 0 });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entry = current.node.entry;
    out.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      role: roleOf(entry),
      preview: previewOf(entry),
      ...(current.node.label ? { label: current.node.label } : {}),
      depth: current.depth,
      active: active.has(entry.id),
      leaf: entry.id === leafId,
    });
    const children = current.node.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return out;
}

export function contextEventsOf(source: Pick<SessionTreeSource, "buildContextEntries">): PiHostEvent[] {
  return readPiJsonl(source.buildContextEntries().map((entry) => JSON.stringify(entry)).join("\n")).events;
}

export function resolveSessionEntry(
  source: Pick<SessionTreeSource, "getEntry" | "getEntries">,
  id: string,
  hint?: { text?: string; role?: "user" | "assistant" },
): string | undefined {
  if (id && source.getEntry(id)) return id;
  const entries = source.getEntries();
  if (id) {
    for (const entry of entries) {
      if (entry.message?.id === id) return entry.id;
    }
  }
  const wanted = hint?.text?.trim();
  if (!wanted) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") continue;
    if (hint?.role && entry.message?.role !== hint.role) continue;
    if (textOf(entry.message?.content).trim() === wanted) return entry.id;
  }
  return undefined;
}

type BranchEntry = {
  id: string;
  type?: string;
  parentId?: string | null;
  targetId?: string;
};

type BranchFile = {
  fileEntries: BranchEntry[];
  leafId: string | null;
  byId: { has(id: string): boolean };
  _buildIndex(): void;
  _rewriteFile(): void;
};

/** 删掉这条侧枝上、当前路径用不到的条目。当前分支删不掉。 */
export function withoutBranch<T extends BranchEntry>(entries: readonly T[], tipId: string, leafId: string | null): T[] {
  const nodes = entries.filter((entry) => entry.type !== "session");
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  if (!byId.has(tipId)) {
    throw Object.assign(new Error(`Entry ${tipId} not found`), {
      reasonCode: "guard.sessionTreeEntryMissing",
    });
  }
  if (!leafId) {
    throw Object.assign(new Error("Cannot delete the current branch"), {
      reasonCode: "guard.sessionTreeCurrentBranch",
    });
  }
  const ancestors = new Set<string>();
  let cursor = leafId ? byId.get(leafId) : undefined;
  while (cursor) {
    ancestors.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (ancestors.has(tipId)) {
    throw Object.assign(new Error("Cannot delete the current branch"), {
      reasonCode: "guard.sessionTreeCurrentBranch",
    });
  }
  const drop = new Set<string>();
  let walk = byId.get(tipId);
  while (walk && !ancestors.has(walk.id)) {
    drop.add(walk.id);
    walk = walk.parentId ? byId.get(walk.parentId) : undefined;
  }
  const children = new Map<string, string[]>();
  for (const entry of nodes) {
    if (!entry.parentId) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry.id);
    children.set(entry.parentId, list);
  }
  const stack = [...drop];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    for (const child of children.get(id) ?? []) {
      if (drop.has(child)) continue;
      drop.add(child);
      stack.push(child);
    }
  }
  for (const entry of nodes) {
    if (entry.type === "label" && entry.targetId && drop.has(entry.targetId)) drop.add(entry.id);
  }
  if (leafId && drop.has(leafId)) {
    throw Object.assign(new Error("Cannot delete the current branch"), {
      reasonCode: "guard.sessionTreeCurrentBranch",
    });
  }
  return entries.filter((entry) => entry.type === "session" || !drop.has(entry.id));
}

/** Pi 的会话文件只追加、不提供删除。这里改内存索引再整文件重写。 */
export function deleteSessionBranch(session: { sessionManager: unknown }, tipId: string): void {
  const manager = session.sessionManager as BranchFile;
  const previous = manager.fileEntries;
  const leaf = manager.leafId;
  const next = withoutBranch(previous, tipId, leaf);
  manager.fileEntries = next;
  try {
    manager._buildIndex();
    if (leaf && manager.byId.has(leaf)) manager.leafId = leaf;
    // 侧枝不在当前画面上。重建上下文再整段重放，大会话会先被清成白屏。
    manager._rewriteFile();
  } catch (error) {
    manager.fileEntries = previous;
    manager._buildIndex();
    manager.leafId = leaf;
    throw error;
  }
}

export function labelSessionEntry(
  source: Pick<SessionTreeSource, "getEntry" | "appendLabelChange">,
  id: string,
  label: string | undefined,
): void {
  if (!source.getEntry(id)) throw new Error(`Entry ${id} not found`);
  const next = label?.trim();
  source.appendLabelChange(id, next ? next : undefined);
}

function entryIdOf(pi: PiSessionPort, request: SessionResumeRequest): string {
  const resolved = pi.resolveEntry?.(request.entryId, { text: request.text, role: request.role });
  if (resolved) return resolved;
  if (!pi.hasEntry || pi.hasEntry(request.entryId)) return request.entryId;
  return "";
}

/** 按 Pi 当前叶子重放。不总结时文件最后一行还是旧叶子，不能读盘。 */
export async function runSessionResume(input: {
  pi: PiSessionPort;
  request: SessionResumeRequest;
  reload: (events: PiHostEvent[]) => void;
  setSummarizing: (active: boolean) => void;
  releaseStop: () => void;
  publishContext: () => void;
}): Promise<SessionResumeResult> {
  if (input.pi.isCompacting) {
    throw Object.assign(new Error("Wait for compaction to finish"), {
      reasonCode: "guard.sessionTreeBusy",
    });
  }
  const entryId = entryIdOf(input.pi, input.request);
  if (!entryId || !input.pi.navigateTree) {
    throw Object.assign(new Error(`Entry ${input.request.entryId} not found`), {
      reasonCode: "guard.sessionTreeEntryMissing",
    });
  }
  if (input.pi.isStreaming) await input.pi.abort();
  // 上一轮的停止不能把接下来的分支总结一起掐掉。
  input.releaseStop();
  if (input.request.summarize) input.setSummarizing(true);
  try {
    const result = await input.pi.navigateTree(entryId, {
      summarize: input.request.summarize,
      ...(input.request.customInstructions
        ? { customInstructions: input.request.customInstructions }
        : {}),
      ...(input.request.label ? { label: input.request.label } : {}),
    });
    const cancelled = Boolean(result && result.cancelled);
    if (!cancelled) {
      if (!input.pi.contextEvents) throw new Error("session tree replay missing");
      input.reload(input.pi.contextEvents());
      input.publishContext();
    }
    return {
      cancelled,
      ...(result && result.editorText ? { editorText: result.editorText } : {}),
      tree: input.pi.readTree?.() ?? [],
    };
  } finally {
    if (input.request.summarize) input.setSummarizing(false);
  }
}
