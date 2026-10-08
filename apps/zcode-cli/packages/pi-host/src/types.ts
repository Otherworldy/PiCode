import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import type { PiContextUsage } from "./context-breakdown.js";
import type { ToolPermissionCheck } from "./permission-gate.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiAssistantDelta =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName?: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall?: { id: string; name: string; arguments?: unknown } };

export type PiToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
};

export type PiHostEvent =
  | { type: "agent_start"; at?: number }
  | { type: "agent_end"; willRetry?: boolean }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "agent_settled"; at?: number }
  | { type: "message_start"; at?: number; message: { role: string; content?: unknown; id?: string } }
  | {
      type: "message_end";
      at?: number;
      message: {
        role: string;
        content?: unknown;
        id?: string;
        stopReason?: string;
        errorMessage?: string;
      };
    }
  | { type: "message_update"; assistantMessageEvent: PiAssistantDelta }
  | {
      type: "tool_execution_start";
      at?: number;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      workId?: string;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult?: PiToolResult;
    }
  | {
      type: "tool_execution_end";
      at?: number;
      toolCallId: string;
      toolName: string;
      result?: PiToolResult;
      isError?: boolean;
      workId?: string;
    }
  | { type: "compaction_start"; reason?: string }
  | {
      type: "compaction_end";
      reason?: string;
      aborted?: boolean;
      errorMessage?: string;
      result?: { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number };
    }
  | { type: "branch_summary"; summary: string }
  | { type: "extension_error"; extensionPath?: string; error: string }
  | PiExtensionUiEvent;

export type PiExtensionUiEvent = {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "ask"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text"
    | "custom";
  title?: string;
  message?: string;
  options?: string[];
  /** ask-me 的结构化问卷。问题和选项分开，不把示意拼进 title。 */
  questions?: HostAskQuestion[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
  pluginId?: string;
  view?: string;
  state?: unknown;
};

export type HostAskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
};

export type HostAskAnswer = {
  question: string;
  answer: string;
  custom: boolean;
  selected?: string[];
  preview?: string;
};

export type PiExtensionUiResponse =
  | { id: string; cancelled: true }
  | { id: string; confirmed: boolean }
  | { id: string; value: string; content?: Record<string, unknown> }
  | { id: string; content: Record<string, unknown> };

export interface PiSlashCommandView {
  name: string;
  description: string;
  inputHint: string;
  source: "builtin" | "custom" | "extension";
}

export interface PiSkillView {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  packageName?: string;
}

export type PiSessionTreeNode = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool" | "summary" | "compaction" | "other";
  preview: string;
  label?: string;
  depth: number;
  active: boolean;
  leaf: boolean;
};

export type SessionResumeRequest = {
  entryId: string;
  text?: string;
  role?: "user" | "assistant" | "tool";
  summarize: boolean;
  customInstructions?: string;
  label?: string;
};

export type SessionResumeResult = {
  cancelled: boolean;
  editorText?: string;
  tree: PiSessionTreeNode[];
};

export interface PiSessionPort {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;
  /** 压缩、重试或轮次还没结束。缺省时按 !isStreaming。 */
  readonly isIdle?: boolean;
  readonly currentModel?: { providerId: string; modelId: string };
  listModels?(): Array<{ providerId: string; modelId: string; name?: string }>;
  /** 这个会话里 Pi 已经加载的技能，含用户目录、项目目录和包技能。 */
  listSkills?(): PiSkillView[];
  /** Pi 自动补全那份斜杠命令：内置、提示词、扩展命令、skill: 。 */
  listSlashCommands?(): PiSlashCommandView[];
  prompt(
    text: string,
    options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> },
  ): Promise<boolean>;
  waitTurn?(): Promise<void>;
  steer(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  followUp(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  abort(): Promise<void>;
  /** 模型失败后从当前上下文接着跑。命令在 agent_start 后返回。 */
  continueAfterError?(): Promise<void>;
  /** pi-processes 列表变化。没装插件时列表一直是空的。 */
  subscribeManagedProcesses?(listener: (works: BackgroundWorkSummary[]) => void): () => void;
  killManagedProcess?(id: string): Promise<boolean>;
  readManagedProcessOutput?(workId: string): Promise<BackgroundBashOutputResult>;
  compact(): Promise<void>;
  /** Pi `getContextUsage()`，外加按来源拆开的估算。 */
  contextUsage?(): PiContextUsage | null;
  readonly isCompacting?: boolean;
  abortBranchSummary?(): void;
  navigateTree?(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{
    editorText?: string;
    cancelled?: boolean;
    aborted?: boolean;
    summaryEntry?: { summary?: string };
  } | void>;
  readTree?(): PiSessionTreeNode[];
  labelEntry?(id: string, label?: string): void;
  deleteBranch?(entryId: string): void;
  contextEvents?(): PiHostEvent[];
  resolveEntry?(
    id: string,
    hint?: { text?: string; role?: "user" | "assistant" | "tool" },
  ): string | undefined;
  /** Pi `createBranchedSession`：新文件只含到该节点的路径。 */
  branchFrom?(entryId: string): { sessionId: string; sessionFile: string };
  hasEntry?(id: string): boolean;
  /** 画面行 id 不是树节点时，用用户原文找回 Pi entry。 */
  matchUserEntry?(text: string): string | undefined;
  setModel?(provider: string, modelId: string, thought?: string): Promise<boolean | void>;
  setThinkingLevel?(level: PiThinkingLevel): void;
  setSteeringMode?(mode: "all" | "one-at-a-time"): void;
  setFollowUpMode?(mode: "all" | "one-at-a-time"): void;
  setSessionName?(name: string): Promise<void> | void;
  bindUi?(ui: unknown): Promise<void>;
  subscribe(listener: (event: PiHostEvent) => void): () => void;
  dispose(): void;
}

export interface CreatePiSessionInput {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  parentSessionId?: string;
  loadExtensions: boolean;
  checkPermission?: ToolPermissionCheck;
}

export type CreatePiSession = (input: CreatePiSessionInput) => Promise<PiSessionPort>;

export function asPiEvent(event: unknown): PiHostEvent | null {
  if (!event || typeof event !== "object" || !("type" in event)) return null;
  return event as PiHostEvent;
}

/** 上下文环跟着 Pi getContextUsage。流式合并，整轮结束才推就晚了。 */
export function contextUsagePublish(event: PiHostEvent): "now" | "soon" | "no" {
  if (event.type === "message_update") return "soon";
  if (
    event.type === "message_end" ||
    event.type === "tool_execution_end" ||
    event.type === "compaction_end" ||
    (event.type === "agent_end" && !event.willRetry)
  ) {
    return "now";
  }
  return "no";
}
