import type { RemoteTarget } from "@zcode/shared";
import type { RemoteTargetSnapshot } from "@zcode/shared";
import { formatRemoteWorkspaceDisplayLabel } from "@/lib/remoteWorkspaceHistory.js";

/** 项目显示名的最大长度；持久化 schema 用同一个上限。 */
export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * 自定义项目名只影响展示：去掉换行与首尾空白，空串视为“没有自定义名”。
 * 清空输入必须回到 undefined，否则侧栏会出现一行空白标题。
 */
export function normalizeWorkspaceDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, WORKSPACE_DISPLAY_NAME_MAX_LENGTH);
}

/**
 * 项目展示名：自定义名优先，其次远程主机名，最后才是目录名。
 *
 * 侧栏、顶栏、命令面板、空态项目菜单、文件树标题都走这里，
 * 避免不同入口对同一个项目显示不同名字。
 */
export function resolveWorkspaceDisplayLabel(
  label: string,
  target?: RemoteTarget | RemoteTargetSnapshot,
  displayName?: string,
): string {
  return (
    normalizeWorkspaceDisplayName(displayName) ?? formatRemoteWorkspaceDisplayLabel(label, target)
  );
}
