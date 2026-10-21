import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { isVisibleAssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";

/**
 * 运行中工作块标题报的活动类别。
 *
 * 口径照 dsh 的 `ProcessActivity`（`conversation-nodes/process-activity.ts`）：
 * 读、读图、搜索、写、改、命令、代码、网页搜索、网页抓取、子智能体、计划、提问、技能，
 * 其余工具落到 `tools`。`thinking` / `answer` 不是工具，是这一块此刻没有在跑的工具时的
 * 回落。
 */
export type WorkActivity =
  | "thinking"
  | "answer"
  | "read"
  | "readImage"
  | "search"
  | "write"
  | "edit"
  | "commands"
  | "code"
  | "webSearch"
  | "webFetch"
  | "subagents"
  | "plan"
  | "questions"
  | "skill"
  | "tools";

export interface WorkActivityState {
  activity: WorkActivity;
  /** 工具参数还在流式，动作还没真正派发：标题要说「准备…」而不是「正在…」。 */
  preparing: boolean;
}

function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    // PascalCase 也归一：展示层叫 `ApplyPatch`，Pi 原生叫 `apply_patch`，两边要认同一个动作。
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

const COMMAND_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "pwsh",
  "powershell",
  "exec_command",
  "write_stdin",
  "run_command",
  "terminal",
]);

const SEARCH_TOOL_NAMES = new Set(["grep", "glob", "search", "find", "list", "ls", "search_files"]);

const PLAN_TOOL_NAMES = new Set([
  "todo_write",
  "todowrite",
  "todo_read",
  "todoread",
  "create_goal",
  "update_goal",
  "get_goal",
  "goalread",
]);

const QUESTION_TOOL_NAMES = new Set([
  "ask_user_question",
  "askuserquestion",
  "request_user_input",
]);

/**
 * 工具名 → 活动类别。大小写和下划线差异（Pi 原生 `read` 与展示层 `Read`）都归一。
 * dsh 只认它自己的 snake_case 名字；PiCode 还要接 PascalCase 与 MCP 前缀。
 */
export function workActivityForToolName(toolName: string): WorkActivity {
  const name = normalizeToolName(toolName);
  if (name === "read" || name === "read_file" || name === "read_files") return "read";
  if (name === "read_image" || name === "image_read" || name === "view_image") return "readImage";
  if (name.endsWith("_inspect")) return "search";
  if (SEARCH_TOOL_NAMES.has(name)) return "search";
  if (name === "write" || name === "write_file") return "write";
  if (
    name === "edit" ||
    name === "apply_patch" ||
    name === "multiedit" ||
    name === "str_replace" ||
    name === "write_file_edit"
  ) {
    return "edit";
  }
  if (name.startsWith("terminal_") || COMMAND_TOOL_NAMES.has(name)) return "commands";
  if (
    name === "js" ||
    name.startsWith("js_") ||
    name === "node_repl" ||
    name === "run_code" ||
    name.startsWith("mcp__node_repl")
  ) {
    return "code";
  }
  if (name === "web_search" || name === "websearch") return "webSearch";
  if (name === "web_fetch" || name === "webfetch" || name === "fetch_url") return "webFetch";
  if (name === "agent" || name === "task" || name === "subagent" || name.startsWith("subagent_")) {
    return "subagents";
  }
  if (PLAN_TOOL_NAMES.has(name)) return "plan";
  if (QUESTION_TOOL_NAMES.has(name)) return "questions";
  if (name === "skill") return "skill";
  return "tools";
}

/**
 * 这一块此刻在做什么。
 *
 * 和 dsh 一样先看还有没有在跑的工具（它是按 tool.time 取最新的 running 工具）。PiCode 的
 * explore 阶段是 UI 聚合出来的，子工具可能先 success 而父阶段仍在跑，所以没有 running 工具
 * 时还要看这一块是不是当前阶段：是就仍报那个工具的动作，不是才回落到思考/正文。
 * 不渲染的空白 reasoning 行（reasoning_start/end 的空 block）不参与判断。
 */
export function resolveWorkActivity(
  rows: readonly AssistantWorkRow[],
  options: { stageRunning: boolean },
): WorkActivityState | null {
  let lastVisible: AssistantWorkRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined || !isVisibleAssistantWorkRow(row)) continue;
    lastVisible ??= row;
    if (row.kind !== "toolCall") continue;
    // 等审批不是「在跑工具」，而是卡在人身上。
    if (row.status === "pendingApproval") return { activity: "questions", preparing: false };
    if (row.status === "running" || row.status === "inputStreaming") {
      return {
        activity: workActivityForToolName(row.toolName),
        preparing: row.status === "inputStreaming",
      };
    }
  }
  if (lastVisible === undefined) return null;
  if (lastVisible.kind === "toolCall") {
    return options.stageRunning
      ? { activity: workActivityForToolName(lastVisible.toolName), preparing: false }
      : { activity: "thinking", preparing: false };
  }
  return {
    activity: lastVisible.kind === "assistantText" ? "answer" : "thinking",
    preparing: false,
  };
}
