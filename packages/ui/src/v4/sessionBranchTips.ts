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

function forkPreview(
  node: SessionTreeNodeView,
  byId: ReadonlyMap<string, SessionTreeNodeView>,
  childCount: ReadonlyMap<string, number>,
): string | null {
  let cursor: SessionTreeNodeView | undefined = node;
  while (cursor?.parentId) {
    const parent = byId.get(cursor.parentId);
    if (!parent) return null;
    if ((childCount.get(parent.id) ?? 0) > 1) return clip(cursor.preview || parent.preview);
    cursor = parent;
  }
  return null;
}

/** 一条分支只保留末梢。当前停在半路时，那个节点也算一条。 */
export function sessionBranchTips(nodes: readonly SessionTreeNodeView[]): SessionBranchTip[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childCount = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
  }
  const active = nodes.find((node) => node.leaf);
  const activeId = active ? anchorOf(active, byId).id : undefined;
  const seen = new Set<string>();
  const tips: SessionTreeNodeView[] = [];
  for (const node of nodes) {
    if ((childCount.get(node.id) ?? 0) !== 0 && !node.leaf) continue;
    let tip = anchorOf(node, byId);
    // 书签落在当前路径上时，删的是侧枝末梢，不是这条还在用的消息。
    if (tip.active && tip.id !== activeId) tip = node;
    if (seen.has(tip.id)) continue;
    seen.add(tip.id);
    tips.push(tip);
  }
  tips.sort((left, right) => Number(right.id === activeId) - Number(left.id === activeId));
  return tips.map((node) => ({
    id: node.id,
    current: node.id === activeId,
    label: node.label ?? null,
    preview: clip(node.preview),
    forkPreview: forkPreview(node, byId, childCount),
  }));
}
