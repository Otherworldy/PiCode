/**
 * 内置角色工具编辑器的候选项与显示名。
 *
 * 候选项顺序：运行时清单（Pi 内置 + 用户包扩展）在前，角色默认与当前选择兜底在后，
 * 这样扩展被卸载后旧覆盖名仍可见、可取消。显示名只影响 UI，落盘一律用 Pi 工具名。
 */
export function mergeSubagentToolOptions(
  catalog: readonly string[],
  ...groups: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...catalog, ...groups.flatMap((group) => group ?? [])]) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

const TOOL_LABELS: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  find: "Find",
  ls: "List",
  bash: "Bash",
  powershell: "PowerShell",
  edit: "Edit",
  write: "Write",
  one_search: "WebSearch",
  web_fetch: "WebFetch",
  get_search_content: "SearchContent",
  source_check: "SourceCheck",
};

export function subagentToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}
