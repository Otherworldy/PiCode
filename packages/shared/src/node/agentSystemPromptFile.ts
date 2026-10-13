import { join } from "node:path";

/** Pi 用这个文件名替换内置系统提示词。 */
export const AGENT_SYSTEM_PROMPT_FILE_NAME = "SYSTEM.md";
/** Pi 用这个文件名追加到已经确定的系统提示词后面。同名文件不与 SYSTEM.md 互相替换。 */
export const AGENT_APPEND_SYSTEM_PROMPT_FILE_NAME = "APPEND_SYSTEM.md";
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = 256 * 1024;

export type AgentSystemPromptScope = "global" | "project";
export type AgentSystemPromptKind = "replace" | "append";

export function agentSystemPromptFileName(kind: AgentSystemPromptKind = "replace"): string {
  return kind === "append" ? AGENT_APPEND_SYSTEM_PROMPT_FILE_NAME : AGENT_SYSTEM_PROMPT_FILE_NAME;
}

/**
 * 空白表示「不要自定义提示词」。Pi 只要文件存在就会整段替换内置提示词，
 * 所以空白必须删文件，不能写成空文件。
 * 返回 null 表示删除；否则返回要落盘的正文。
 */
export function prepareAgentSystemPromptWrite(content: string): string | null {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.trim()) return null;
  if (new TextEncoder().encode(text).byteLength > AGENT_SYSTEM_PROMPT_MAX_BYTES) {
    throw new Error("System prompt is too large");
  }
  return text;
}

export function resolvePiAgentDir(env: { PI_CODING_AGENT_DIR?: string }, home: string): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override || join(home, ".pi", "agent");
}

export function localAgentSystemPromptPath(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir: string;
  kind?: AgentSystemPromptKind;
}): string {
  const name = agentSystemPromptFileName(input.kind);
  if (input.scope === "global") {
    return join(input.agentDir, name);
  }
  const root = input.rootPath?.trim() ?? "";
  if (!root) throw new Error("Workspace path is required");
  return join(root, ".pi", name);
}

/** 远端项目提示词。根目录 `/` 得到 `/.pi/SYSTEM.md` 或 `/.pi/APPEND_SYSTEM.md`。 */
export function remoteAgentSystemPromptPath(
  remoteRoot: string,
  kind: AgentSystemPromptKind = "replace",
): string {
  const trimmed = remoteRoot.trim();
  if (!trimmed) throw new Error("Workspace path is required");
  const root = trimmed === "/" ? "" : trimmed.replace(/\/+$/u, "");
  return `${root}/.pi/${agentSystemPromptFileName(kind)}`;
}
