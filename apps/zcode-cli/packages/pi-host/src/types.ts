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
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "message_start"; message: { role: string; content?: unknown; id?: string } }
  | { type: "message_end"; message: { role: string; content?: unknown; id?: string; stopReason?: string } }
  | { type: "message_update"; assistantMessageEvent: PiAssistantDelta }
  | {
      type: "tool_execution_start";
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
      result?: { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number };
    }
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
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text"
    | "custom";
  title?: string;
  message?: string;
  options?: string[];
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

export type PiExtensionUiResponse =
  | { id: string; cancelled: true }
  | { id: string; confirmed: boolean }
  | { id: string; value: string };

export interface PiSkillView {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  packageName?: string;
}

export interface PiSessionPort {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;
  readonly currentModel?: { providerId: string; modelId: string };
  listModels?(): Array<{ providerId: string; modelId: string; name?: string }>;
  /** 这个会话里 Pi 已经加载的技能，含用户目录、项目目录和包技能。 */
  listSkills?(): PiSkillView[];
  prompt(text: string): Promise<boolean>;
  waitTurn?(): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  navigateTree?(targetId: string): Promise<unknown>;
  /** Pi `createBranchedSession`：新文件只含到该节点的路径。 */
  branchFrom?(entryId: string): { sessionId: string; sessionFile: string };
  hasEntry?(id: string): boolean;
  /** 画面行 id 不是树节点时，用用户原文找回 Pi entry。 */
  matchUserEntry?(text: string): string | undefined;
  setModel?(provider: string, modelId: string, thought?: string): Promise<void>;
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
