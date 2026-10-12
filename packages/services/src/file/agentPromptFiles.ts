import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_PROMPT_MAX_BYTES,
  assertAgentPromptFileName,
  localAgentPromptsDir,
  prepareAgentPromptWrite,
  type AgentSystemPromptScope,
} from "@zcode/shared/node";
import { currentPiAgentDir } from "./agentSystemPrompt.js";

export interface AgentPromptList {
  directory: string;
  files: string[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function directoryOf(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
}): string {
  return localAgentPromptsDir({
    scope: input.scope,
    rootPath: input.rootPath,
    agentDir: input.agentDir ?? currentPiAgentDir(),
  });
}

export async function listAgentPromptFiles(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
}): Promise<AgentPromptList> {
  const directory = directoryOf(input);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      const file = entry.isSymbolicLink()
        ? await stat(join(directory, entry.name)).then(
            (fileStat) => fileStat.isFile(),
            () => false,
          )
        : entry.isFile();
      if (!file) continue;
      try {
        files.push(assertAgentPromptFileName(entry.name));
      } catch {
        // 带路径片段的名字不是 Pi 的一层命令文件。
      }
    }
    files.sort((left, right) => left.localeCompare(right));
    return { directory, files };
  } catch (error) {
    if (isEnoent(error)) return { directory, files: [] };
    throw error;
  }
}

export async function readAgentPromptFile(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
  name: string;
}): Promise<{ directory: string; name: string; content: string }> {
  const directory = directoryOf(input);
  const name = assertAgentPromptFileName(input.name);
  const path = join(directory, name);
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`Path is not a file: ${path}`);
  if (fileStat.size > AGENT_PROMPT_MAX_BYTES) throw new Error("Prompt is too large");
  const raw = await readFile(path, "utf8");
  return {
    directory,
    name,
    content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
  };
}

export async function writeAgentPromptFile(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
  name: string;
  content: string;
}): Promise<{ directory: string; name: string }> {
  const directory = directoryOf(input);
  const name = assertAgentPromptFileName(input.name);
  const content = prepareAgentPromptWrite(input.content);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content, "utf8");
  return { directory, name };
}

export async function deleteAgentPromptFile(input: {
  scope: AgentSystemPromptScope;
  rootPath?: string;
  agentDir?: string;
  name: string;
}): Promise<void> {
  const directory = directoryOf(input);
  const name = assertAgentPromptFileName(input.name);
  await rm(join(directory, name), { force: true });
}
