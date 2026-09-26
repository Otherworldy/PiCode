import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { TUI_ONLY_PI_SLASH_COMMANDS } from "@zcode/shared";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import type { PiSlashCommandView } from "./types.js";

export type { PiSlashCommandView };

/** 与 Pi `BUILTIN_SLASH_COMMANDS` 同序。终端专属项不进 GUI 目录。 */
const PI_BUILTIN_SLASH_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit Pi" },
] as const;

interface NamedCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

interface PiSlashCommandParts {
  templates: readonly NamedCommand[];
  extensions: readonly NamedCommand[];
}

export function assemblePiSlashCommands(parts: PiSlashCommandParts): PiSlashCommandView[] {
  const builtins = PI_BUILTIN_SLASH_COMMANDS.filter(
    (command) => !TUI_ONLY_PI_SLASH_COMMANDS.has(command.name),
  ).map((command) => toView(command, "builtin"));
  const taken = new Set(builtins.map((command) => command.name));
  const rest = [
    ...parts.templates.map((command) => toView(command, "custom")),
    ...parts.extensions.map((command) => toView(command, "extension")),
  ].filter((command) => {
    if (taken.has(command.name) || command.name.startsWith("skill:")) return false;
    taken.add(command.name);
    return true;
  });
  return [...builtins, ...rest];
}

interface PiCommandSession {
  promptTemplates: ReadonlyArray<NamedCommand>;
  extensionRunner: {
    getRegisteredCommands(): ReadonlyArray<NamedCommand & { invocationName: string }>;
  };
}

/** 活会话：GUI 能用的内置命令、提示词、扩展命令。技能不进命令目录。 */
export function listSessionSlashCommands(session: PiCommandSession): PiSlashCommandView[] {
  return assemblePiSlashCommands({
    templates: session.promptTemplates,
    extensions: session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
    })),
  });
}

/** 还没有会话时不加载扩展。提示词目录仍跟 Pi。 */
export async function listPiSlashCommands(
  cwd: string,
  agentDir?: string,
): Promise<PiSlashCommandView[]> {
  await ensurePiSdk();
  const coding = piCoding();
  const dir = agentDir ?? coding.getAgentDir();
  return assemblePiSlashCommands({
    templates: [
      ...readPromptDir(join(dir, "prompts")),
      ...readPromptDir(join(cwd, coding.CONFIG_DIR_NAME, "prompts")),
    ],
    extensions: [],
  });
}

function readPromptDir(dir: string): NamedCommand[] {
  if (!existsSync(dir)) return [];
  const commands: NamedCommand[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const parsed = parseFrontmatter(readFileSync(join(dir, entry.name), "utf8"));
      const name = basename(entry.name, ".md");
      const described = parsed.frontmatter.description;
      let description = typeof described === "string" ? described : "";
      if (!description) {
        const firstLine = parsed.body.split("\n").find((line) => line.trim());
        if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
      }
      const hint = parsed.frontmatter["argument-hint"];
      commands.push({
        name,
        description,
        ...(typeof hint === "string" && hint.trim() ? { argumentHint: hint.trim() } : {}),
      });
    } catch {
      // 坏掉的提示词文件不挡住整份目录。
    }
  }
  return commands;
}

function toView(command: NamedCommand, source: PiSlashCommandView["source"]): PiSlashCommandView {
  const hint = command.argumentHint?.trim();
  return {
    name: command.name,
    description: command.description?.trim() ?? "",
    inputHint: hint ? `/${command.name} ${hint}` : `/${command.name}`,
    source,
  };
}
