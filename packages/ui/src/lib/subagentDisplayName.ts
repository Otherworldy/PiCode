import { BUILT_IN_SUBAGENT_NAMES, type BuiltInSubagentName } from "@zcode/shared";

/**
 * 内置子智能体的展示名。
 *
 * 名字本身是协议事实：`picode_subagent` 的 `agent` 入参、`.role` 文件、设置页的 md 文件名
 * 都写英文 wire 名。翻译只发生在展示这一层，不改变派发、日志和提示词里的名字，
 * 否则同一次派发在不同语言界面下会指向不同角色，历史会话也会跟着变。
 *
 * 用户自建与插件角色没有词条：那些名字是人给的，原样展示。
 */
const BUILT_IN_SUBAGENT_NAME_SET = new Set<string>(BUILT_IN_SUBAGENT_NAMES);

/** 只认 `id`：调用方传的就是 `intl.formatMessage`，没词条时它原样返回 id。 */
export type SubagentMessageFormatter = (descriptor: { id: string }) => string;

type MessageFormatter = SubagentMessageFormatter;

export function isBuiltInSubagentName(name: string): name is BuiltInSubagentName {
  return BUILT_IN_SUBAGENT_NAME_SET.has(name);
}

/**
 * 角色名 → 当前语言的展示名。
 *
 * 不认识的词条回退原名：`formatMessage` 缺 key 时会把 id 原样打出来，
 * 不能把它当成名字显示。名字为空时返回空串，调用方据此决定要不要显示。
 */
export function subagentDisplayName(name: string, formatMessage: MessageFormatter): string {
  const trimmed = name.trim();
  if (!trimmed || !isBuiltInSubagentName(trimmed)) return trimmed;
  const id = `subagent.builtin.${trimmed}`;
  const message = formatMessage({ id });
  return message === id ? trimmed : message;
}

/**
 * 标题里恰好是角色名时一并翻译。
 *
 * 子会话没有自己的标题时，宿主拿角色名兜底当标题（`pi-subagent-index.ts`），
 * 侧边面板的 tab 因此可能显示成 `worker`。只有整串等于内置角色名才翻译：
 * 任务标题是用户或模型写的自由文本，不能按角色名做词条匹配。
 */
export function subagentDisplayTitle(title: string, formatMessage: MessageFormatter): string {
  const trimmed = title.trim();
  if (!trimmed || !isBuiltInSubagentName(trimmed)) return title;
  return subagentDisplayName(trimmed, formatMessage);
}

/**
 * 内置角色的描述。
 *
 * 描述不只是设置页的说明文字：`host-capabilities.ts` 把它拼进 `picode_subagent`
 * 的工具说明交给模型选角色。所以和名字一样只翻展示层，`description` 本身不动。
 *
 * 与 `builtinSkillI18n.ts` 的 `resolveSkillDisplayDescription` 同一口径：只有内置角色
 * 有词条，用户自建与插件角色的描述是人写的，原样返回。
 */
export function subagentDisplayDescription(
  name: string,
  description: string,
  formatMessage: MessageFormatter,
): string {
  const trimmed = name.trim();
  if (!trimmed || !isBuiltInSubagentName(trimmed)) return description;
  const id = `subagent.builtin.${trimmed}.description`;
  const message = formatMessage({ id });
  return message === id ? description : message;
}
