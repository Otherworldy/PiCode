import { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";

/** 把内容搜索挂到这个 xterm 上。调用方负责和 term 同一生命周期 dispose。 */
export function attachTerminalSearchAddon(term: XTerm): SearchAddon {
  const addon = new SearchAddon();
  term.loadAddon(addon);
  return addon;
}
