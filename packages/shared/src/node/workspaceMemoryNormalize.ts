import {
  parseDateOnly,
  WORKSPACE_MEMORY_CATEGORIES,
  WORKSPACE_MEMORY_DEFAULT_CATEGORY,
  WORKSPACE_MEMORY_DEFAULT_SOURCE,
  WORKSPACE_MEMORY_DEFAULT_TYPE,
  WORKSPACE_MEMORY_SOURCES,
  WORKSPACE_MEMORY_TYPES,
} from "./workspaceMemory.js";

/** 条目 frontmatter 的规范字段与顺序。 */
const ITEM_KEYS = [
  "name",
  "description",
  "category",
  "type",
  "source",
  "confirmed",
  "lastConfirmed",
  "expires",
] as const;
type ItemKey = (typeof ITEM_KEYS)[number];

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const FIELD_LINE = /^([A-Za-z][\w-]*):\s*(.*)$/u;
const DESCRIPTION_MAX_CHARS = 120;

export interface WorkspaceMemoryNormalizeResult {
  content: string;
  changed: boolean;
}

function unquote(value: string | undefined): string {
  return (value ?? "").replace(/^["']|["']$/gu, "").trim();
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const normalized = unquote(value).toLowerCase();
  return allowed.find((item) => item === normalized) ?? fallback;
}

/** 正文第一行当 description：模型漏写 description 时，索引指针行才有可展示的悬停。 */
function firstBodyLine(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const text = line.replace(/^[#>\-*\s]+/u, "").trim();
    if (!text) continue;
    return text.length > DESCRIPTION_MAX_CHARS
      ? `${text.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`
      : text;
  }
  return undefined;
}

/** 含 `:` / `#` 的值不加引号会被 YAML 读成嵌套结构或注释。 */
function formatValue(value: string): string {
  return /[:#]/u.test(value) ? JSON.stringify(value) : value;
}

/**
 * 把一条记忆的 frontmatter 补齐到契约：缺字段填缺省、枚举写歪回退、日期写歪重写。
 *
 * 主模型用 Write/Edit 直接写记忆时不会守字段契约（实测会写 `type: convention` 并
 * 漏掉 `category` / `source` / `confirmed` / `lastConfirmed`）。解析是宽容的，但宽容
 * 只能保证“不丢记忆”，索引行、分类展示和过期判定都需要规范值，所以在写入那一刻归一。
 *
 * 只补/改 frontmatter 字段，正文与未知字段原样保留。
 */
export function normalizeWorkspaceMemoryItem(
  content: string,
  input: { fileName: string; today?: string },
): WorkspaceMemoryNormalizeResult {
  const match = FRONTMATTER_BLOCK.exec(content);
  const body = match ? content.slice(match[0].length) : content;
  const blockLines = match ? (match[1] ?? "").split(/\r?\n/u) : [];
  const raw = new Map<string, string>();
  for (const line of blockLines) {
    const parsed = FIELD_LINE.exec(line);
    const key = parsed?.[1];
    if (key === undefined) continue;
    raw.set(key, parsed?.[2] ?? "");
  }

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const name = unquote(raw.get("name")) || input.fileName.replace(/\.md$/iu, "");
  const description = unquote(raw.get("description")) || firstBodyLine(body);
  const expires = unquote(raw.get("expires"));
  const lastConfirmed = unquote(raw.get("lastConfirmed"));
  const values: Partial<Record<ItemKey, string>> = {
    name,
    ...(description ? { description } : {}),
    category: pick(
      raw.get("category"),
      WORKSPACE_MEMORY_CATEGORIES,
      WORKSPACE_MEMORY_DEFAULT_CATEGORY,
    ),
    type: pick(raw.get("type"), WORKSPACE_MEMORY_TYPES, WORKSPACE_MEMORY_DEFAULT_TYPE),
    source: pick(raw.get("source"), WORKSPACE_MEMORY_SOURCES, WORKSPACE_MEMORY_DEFAULT_SOURCE),
    confirmed: unquote(raw.get("confirmed")).toLowerCase() === "true" ? "true" : "false",
    lastConfirmed: parseDateOnly(lastConfirmed) !== null ? lastConfirmed : today,
    // 写歪的 expires 当没写：留着一行坏日期只会让过期判定永远读到 null。
    ...(expires && parseDateOnly(expires) !== null ? { expires } : {}),
  };

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of blockLines) {
    const key = FIELD_LINE.exec(line)?.[1];
    if (key === undefined || !(ITEM_KEYS as readonly string[]).includes(key)) {
      if (line.trim()) lines.push(line);
      continue;
    }
    // 同一键写两行是模型的常见笔误（真机出过重复 description）：只保留一行，值取最后一次。
    if (seen.has(key)) continue;
    seen.add(key);
    const value = values[key as ItemKey];
    if (value === undefined) continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }
  for (const key of ITEM_KEYS) {
    if (seen.has(key)) continue;
    const value = values[key];
    if (value === undefined) continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }

  const next = `---\n${lines.join("\n")}\n---\n${body}`;
  return { content: next, changed: next !== content };
}
