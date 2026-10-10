const PUSHABLE_COLLABORATION_MODES = new Set(["build", "edit", "yolo"]);

/**
 * 输入框已经显示的模式和投影不一致时，要再写给 Host。
 * 会话重建后投影回到 build，草稿仍是完全访问；再点同一个选项不会发命令。
 */
export function collaborationModeMismatch(
  draftMode: string | undefined,
  snapshotMode: string | undefined,
): "build" | "edit" | "yolo" | null {
  if (!draftMode || !PUSHABLE_COLLABORATION_MODES.has(draftMode)) return null;
  if (!snapshotMode || snapshotMode === draftMode) return null;
  return draftMode as "build" | "edit" | "yolo";
}
