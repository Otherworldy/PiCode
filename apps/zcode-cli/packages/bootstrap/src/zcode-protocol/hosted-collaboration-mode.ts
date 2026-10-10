import type { CollaborationMode, PermissionRuleset } from "@zcode/contracts";

const STORED_COLLABORATION_MODES = ["build", "edit", "plan", "yolo"] as const;

/** 会话行上能恢复的权限。auto 未实现，不能在重启后把工具全部拒绝。 */
export function storedCollaborationMode(mode: unknown): CollaborationMode | undefined {
  return STORED_COLLABORATION_MODES.find((candidate) => candidate === mode);
}

/** 保留已有规则，只改 mode。整份替换会把项目级 allow/deny 抹掉。 */
export function permissionWithCollaborationMode(
  permission: PermissionRuleset | null | undefined,
  mode: string,
): PermissionRuleset {
  return {
    ...(permission ?? {}),
    mode: storedCollaborationMode(mode) ?? "build",
  };
}
