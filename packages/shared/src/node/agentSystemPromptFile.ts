import { join } from "node:path";

/** Pi 用这个文件名替换内置系统提示词。不是 APPEND_SYSTEM.md。 */
export const AGENT_SYSTEM_PROMPT_FILE_NAME = "SYSTEM.md";
export const AGENT_SYSTEM_PROMPT_MAX_BYTES = 256 * 1024;

export type AgentSystemPromptScope = "global" | "project";

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

export function resolvePiAgentDir(
  env: { PI_CODING_AGENT_DIR?: string },
  home: string,
): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override || join(home, ".pi", "agent");
}

export function localAgentSystemPromptPath(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir: string;
}): string {
  if (input.scope === "global") {
    return join(input.agentDir, AGENT_SYSTEM_PROMPT_FILE_NAME);
  }
  const root = input.rootPath?.trim() ?? "";
  if (!root) throw new Error("Workspace path is required");
  return join(root, ".pi", AGENT_SYSTEM_PROMPT_FILE_NAME);
}

/** 远端项目提示词。根目录 `/` 得到 `/.pi/SYSTEM.md`。 */
export function remoteAgentSystemPromptPath(remoteRoot: string): string {
  const trimmed = remoteRoot.trim();
  if (!trimmed) throw new Error("Workspace path is required");
  const root = trimmed === "/" ? "" : trimmed.replace(/\/+$/u, "");
  return `${root}/.pi/${AGENT_SYSTEM_PROMPT_FILE_NAME}`;
}
