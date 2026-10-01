import type { SessionTreeNodeView } from "@zcode/shared/zcode-protocol-v4";

export type SessionBranchTip = {
  id: string;
  current: boolean;
  label: string | null;
  preview: string;
  /** 分叉后的第一条。没有就是主路径。 */
  forkPreview: string | null;
};

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 41)}…` : flat;
}

function isMarker(node: SessionTreeNodeView): boolean {
  return node.role === "other" || node.role === "compaction" || node.role === "tool";
}

/** 标签条目只是书签，分支名落在它上面的消息上。 */
function anchorOf(
  node: SessionTreeNodeView,
  byId: ReadonlyMap<string, SessionTreeNodeView>,
): SessionTreeNodeView {
  let cursor = node;
  while (isMarker(cursor) && cursor.parentId) {
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor;
}

function visibleParent(
  node: SessionTreeNodeView,
  byId: ReadonlyMap<string, SessionTreeNodeView>,
): string | null {
  let parentId = node.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (!isMarker(parent)) return parent.id;
    parentId = parent.parentId;
  }
  return null;
}

function forkPreview(
  node: SessionTreeNodeView,
  byId: ReadonlyMap<string, SessionTreeNodeView>,
  childCount: ReadonlyMap<string, number>,
): string | null {
  let cursor: SessionTreeNodeView | undefined = node;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parentId = visibleParent(cursor, byId);
    if (!parentId) return null;
    const parent = byId.get(parentId);
    if (!parent) return null;
    if ((childCount.get(parent.id) ?? 0) > 1) return clip(cursor.preview || parent.preview);
    cursor = parent;
  }
  return null;
}

/** 一条分支只保留末梢。当前停在半路时，那个节点也算一条。label 条目不是分支。 */
export function sessionBranchTips(nodes: readonly SessionTreeNodeView[]): SessionBranchTip[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const content = nodes.filter((node) => !isMarker(node));
  const childCount = new Map<string, number>();
  for (const node of content) {
    const parentId = visibleParent(node, byId);
    if (!parentId) continue;
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
  }
  const leaf = nodes.find((node) => node.leaf);
  const activeId = leaf ? anchorOf(leaf, byId).id : undefined;
  const seen = new Set<string>();
  const tips: SessionTreeNodeView[] = [];
  for (const node of content) {
    if ((childCount.get(node.id) ?? 0) !== 0 && node.id !== activeId) continue;
    // 过滤幽灵分支：未命名、非当前活动分支的废弃末梢（如重试/中途取消丢下的无正文死节点）
    if (node.id !== activeId && !node.label && !node.preview.trim()) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    tips.push(node);
  }
  return tips.map((node) => ({
    id: node.id,
    current: node.id === activeId,
    label: node.label && node.label !== "label" ? node.label : null,
    preview: clip(node.preview),
    forkPreview: forkPreview(node, byId, childCount),
  }));
}
