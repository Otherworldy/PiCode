import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  localAgentSystemPromptPath,
  prepareAgentSystemPromptWrite,
  resolvePiAgentDir,
  type AgentSystemPromptScope,
} from "@zcode/shared/node";

export interface AgentSystemPromptFile {
  content: string;
  exists: boolean;
  path: string;
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function currentPiAgentDir(): string {
  return resolvePiAgentDir(process.env, homedir());
}

export async function readAgentSystemPromptFile(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
}): Promise<AgentSystemPromptFile> {
  const path = localAgentSystemPromptPath({
    scope: input.scope,
    rootPath: input.rootPath,
    agentDir: input.agentDir ?? currentPiAgentDir(),
  });
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      throw new Error(`Path is not a file: ${path}`);
    }
    // 编辑器不能截断后回存，否则一次保存会把超限文件写短。
    if (fileStat.size > AGENT_SYSTEM_PROMPT_MAX_BYTES) {
      throw new Error("System prompt is too large");
    }
    return { content: stripBom(await readFile(path, "utf8")), exists: true, path };
  } catch (error) {
    if (isEnoent(error)) return { content: "", exists: false, path };
    throw error;
  }
}

export async function writeAgentSystemPromptFile(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  content: string;
  agentDir?: string;
}): Promise<AgentSystemPromptFile> {
  const path = localAgentSystemPromptPath({
    scope: input.scope,
    rootPath: input.rootPath,
    agentDir: input.agentDir ?? currentPiAgentDir(),
  });
  const next = prepareAgentSystemPromptWrite(input.content);
  if (next === null) {
    await rm(path, { force: true });
    return { content: "", exists: false, path };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return { content: next, exists: true, path };
}
