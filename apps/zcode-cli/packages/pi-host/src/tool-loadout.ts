/**
 * 插件注册的 `plannotator` 工具。UI 设计模式靠它的 `annotate` 打开审查页。
 *
 * 插件把它注册成 `defaultActive: false`，激活放在自己的 `session_start` 里，而宿主绑定 UI
 * 是异步的：新会话的第一条消息、会话重放和阶段恢复都可能让这一轮请求的工具列表里没有它。
 * 所以每次把用户消息交给模型之前，宿主自己确认一次。
 */
export const PLANNOTATOR_TOOL_NAME = "plannotator";

/** 只碰会话的激活列表。没注册的工具（用户关了插件工具开关）不在这里凭空造。 */
export type ToolLoadoutPort = {
  getToolDefinition(name: string): unknown;
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
};

/**
 * 工具已注册却不在激活列表里时补回去。同步、幂等，可以每次发送前调用。
 * 返回是否真的补了，方便测试和排查。
 */
export function ensurePlannotatorToolActive(session: ToolLoadoutPort): boolean {
  if (!session.getToolDefinition(PLANNOTATOR_TOOL_NAME)) return false;
  const active = session.getActiveToolNames();
  if (active.includes(PLANNOTATOR_TOOL_NAME)) return false;
  session.setActiveToolsByName([...active, PLANNOTATOR_TOOL_NAME]);
  return true;
}
