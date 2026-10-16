import { isPiProcessSlashCommand, TUI_ONLY_PI_SLASH_COMMANDS } from "@zcode/shared";

export type V4VisibleSlashCommand =
  | {
      kind: "compact";
      displayText: string;
    }
  | {
      kind: "planShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "unsupportedPlanShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "sendGoalCommand";
      objective: string;
      displayText: string;
    }
  | {
      kind: "resumeGoal";
      displayText: string;
    }
  | {
      kind: "emptyGoal";
      displayText: string;
    }
  | {
      kind: "unsupportedGoal";
      action: string;
      displayText: string;
    };

interface V4VisibleSlashCommandParseOptions {
  contextAttachmentCount?: number;
}

interface SelectionSideSlashCommand {
  command: "side" | "btw";
  text: string;
  displayText: string;
}

interface SelectionSideSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** CLI catalog 中已经注册的同名命令；同名 CLI 命令优先，不由 App 消费。 */
  enabledCommandNames?: readonly string[];
}

const GOAL_COMMAND_RE = /^\/(?:goal|target)(?:\s|$)/i;
const TERMINAL_ONLY_SLASH_EXEMPT = new Set(["compact", "plan"]);
const PLANNOTATOR_PLAN_COMMAND = "plannotator-plan-mode";

/** 斜杠目录里有插件命令时，输入框才显示计划开关。 */
export function plannotatorPlanAvailable(
  commands: readonly { name: string }[] | null | undefined,
): boolean {
  return (commands ?? []).some(
    (command) => command.name.trim().replace(/^\/+/, "") === PLANNOTATOR_PLAN_COMMAND,
  );
}

/** 插件 setStatus("plannotator") 表示正在计划或执行。 */
export function plannotatorPlanActive(
  statuses: readonly { key: string }[] | null | undefined,
): boolean {
  return (statuses ?? []).some((status) => status.key === "plannotator");
}

/** 宿主 setStatus("ui-design") 表示 UI 设计模式开着。 */
export function uiDesignModeActive(
  statuses: readonly { key: string }[] | null | undefined,
): boolean {
  return (statuses ?? []).some((status) => status.key === "ui-design");
}

/** Pi 终端菜单里的命令。compact / plan 已有 GUI 行为，其余提交不能变成用户消息。 */
/** 当前目录里的扩展命令。新建任务上跑它不能提升成新会话。 */
export function isExtensionSlashCommand(
  content: string,
  commands: readonly { name: string; source?: "builtin" | "custom" | "extension" }[],
): boolean {
  const name = /^\/([^\s]+)/.exec(content.trim())?.[1]?.toLowerCase();
  if (!name) return false;
  return commands.some(
    (command) =>
      command.source === "extension" &&
      command.name.trim().replace(/^\/+/, "").toLowerCase() === name,
  );
}

export function isTerminalOnlySlashCommand(
  content: string,
  commands: readonly { name: string; source?: "builtin" | "custom" | "extension" }[],
): boolean {
  const match = /^\/([^\s]+)/.exec(content.trim());
  const name = match?.[1]?.toLowerCase();
  if (!name || TERMINAL_ONLY_SLASH_EXEMPT.has(name)) return false;
  if (TUI_ONLY_PI_SLASH_COMMANDS.has(name) || isPiProcessSlashCommand(name)) return true;
  return commands.some(
    (command) =>
      command.source === "builtin" &&
      command.name.trim().replace(/^\/+/, "").toLowerCase() === name,
  );
}

export function parseV4VisibleSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: V4VisibleSlashCommandParseOptions = {},
): V4VisibleSlashCommand | null {
  const displayText = content.trim();
  if (!displayText.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(displayText);
  if (!match) return null;
  const commandName = match[1]?.toLowerCase() ?? "";
  const args = match[2]?.trim() ?? "";

  if (commandName === "plan") {
    const hasUnsupportedPayload =
      attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0;
    return {
      kind: hasUnsupportedPayload ? "unsupportedPlanShortcut" : "planShortcut",
      task: args,
      displayText,
    };
  }

  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) {
    return null;
  }

  if (commandName === "compact" || commandName === "compress") {
    return { kind: "compact", displayText };
  }
  if (commandName !== "goal" && commandName !== "target") {
    return null;
  }
  if (!args) return { kind: "emptyGoal", displayText };

  const action = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (action === "resume") return { kind: "resumeGoal", displayText };
  if (action === "pause" || action === "clear" || action === "show") {
    return { kind: "unsupportedGoal", action, displayText };
  }
  const objective = action === "replace" ? args.replace(/^replace\s*/i, "").trim() : args;
  if (!objective) return { kind: "emptyGoal", displayText };
  return { kind: "sendGoalCommand", objective, displayText };
}

/**
 * 解析带首条输入的选择副屏命令。
 *
 * 这是 App 层的完整输入消费门：只接受整条文本，且只在没有附件/结构化上下文时
 * 命中。参数只去除首尾空白，保留正文内部的空格和换行，避免改写用户原文。
 */
export function parseSelectionSideSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: SelectionSideSlashCommandParseOptions = {},
): SelectionSideSlashCommand | null {
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) return null;
  const displayText = content.trim();
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(displayText);
  if (!match) return null;
  const command = match[1]?.toLowerCase() as SelectionSideSlashCommand["command"] | undefined;
  const enabledNames = options.enabledCommandNames;
  if (
    enabledNames &&
    !enabledNames.some((name) => name.trim().replace(/^\/+/, "").toLowerCase() === command)
  ) {
    return null;
  }
  const text = match[2]?.trim() ?? "";
  if (!text || !command) return null;
  return { command, text, displayText };
}

export function v4QueuedCommandText(kind: "sendText" | "sendGoalCommand", text: string): string {
  if (kind !== "sendGoalCommand") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  return GOAL_COMMAND_RE.test(trimmed) ? text : `/goal ${trimmed}`;
}
