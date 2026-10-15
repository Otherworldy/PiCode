/** window capture 转发给当前终端会话的查找请求。detail 是触发快捷键的事件目标。 */
export const TERMINAL_FIND_EVENT = "zcode-terminal-find";

export const TERMINAL_SESSION_SELECTOR = "[data-terminal-session]";

export type TerminalFindResult = {
  resultIndex: number;
  resultCount: number;
};

export type TerminalFindCount =
  | { kind: "idle" }
  | { kind: "none" }
  | { kind: "overflow"; total: number }
  | { kind: "match"; current: number; total: number };

const SEARCH_DECORATIONS = {
  matchBackground: "#5c5340",
  activeMatchBackground: "#eab308",
  matchOverviewRuler: "#5c5340",
  activeMatchColorOverviewRuler: "#eab308",
} as const;

/**
 * 任务内查找快捷键是否应交给终端内容搜索。
 * 全局分发在 window capture，终端 textarea 收不到这次按键；必须在分发处改道。
 */
export function shouldOpenTerminalFind(commandId: string, insideTerminalSession: boolean): boolean {
  return commandId === "findInTask" && insideTerminalSession;
}

/** 事件目标是否落在某个终端会话里（含 xterm textarea 和查找条输入框）。 */
export function isTerminalSessionEventTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined") return false;
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(element?.closest(TERMINAL_SESSION_SELECTOR));
}

export type TerminalSearchOptions = {
  caseSensitive: boolean;
  incremental: boolean;
  decorations: {
    matchBackground: string;
    activeMatchBackground: string;
    matchOverviewRuler: string;
    activeMatchColorOverviewRuler: string;
  };
};

export function terminalSearchOptions(
  caseSensitive: boolean,
  incremental: boolean,
): TerminalSearchOptions {
  return {
    caseSensitive,
    incremental,
    decorations: SEARCH_DECORATIONS,
  };
}

/** 把 SearchAddon 的结果编成查找条能直接渲染的计数。resultIndex 为 -1 表示超过高亮上限。 */
export function formatTerminalFindCount(
  query: string,
  result: TerminalFindResult | null,
): TerminalFindCount {
  if (query.length === 0) return { kind: "idle" };
  if (!result || result.resultCount <= 0) return { kind: "none" };
  if (result.resultIndex < 0) return { kind: "overflow", total: result.resultCount };
  return { kind: "match", current: result.resultIndex + 1, total: result.resultCount };
}
