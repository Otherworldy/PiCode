import { join } from "node:path";
import type { AgentSystemPromptScope } from "./agentSystemPromptFile.js";

export const AGENT_PROMPT_MAX_BYTES = 256 * 1024;

/** Pi 只把 prompts 目录这一层的 .md 当成斜杠命令，文件名就是命令名。 */
export function assertAgentPromptFileName(fileName: string): string {
  const name = fileName.trim();
  if (
    !name.endsWith(".md") ||
    name === ".md" ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("..")
  ) {
    throw new Error("Invalid prompt name");
  }
  return name;
}

export function agentPromptFileNameFromLabel(label: string): string {
  const trimmed = label.trim();
  const base = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -3).trim() : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base)) {
    throw new Error("Invalid prompt name");
  }
  return assertAgentPromptFileName(`${base}.md`);
}

export function prepareAgentPromptWrite(content: string): string {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (new TextEncoder().encode(text).byteLength > AGENT_PROMPT_MAX_BYTES) {
    throw new Error("Prompt is too large");
  }
  return text;
}

export function localAgentPromptsDir(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir: string;
}): string {
  if (input.scope === "global") return join(input.agentDir, "prompts");
  const root = input.rootPath?.trim() ?? "";
  if (!root) throw new Error("Workspace path is required");
  return join(root, ".pi", "prompts");
}

export function remoteAgentPromptsDir(remoteRoot: string): string {
  const trimmed = remoteRoot.trim();
  if (!trimmed) throw new Error("Workspace path is required");
  const root = trimmed === "/" ? "" : trimmed.replace(/\/+$/u, "");
  return `${root}/.pi/prompts`;
}

export function remoteAgentPromptPath(remoteRoot: string, fileName: string): string {
  return `${remoteAgentPromptsDir(remoteRoot)}/${assertAgentPromptFileName(fileName)}`;
}
