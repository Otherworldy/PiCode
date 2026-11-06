// ============================================================
// Core package exports
// ============================================================

// Agent components
export * from "./agent/index.js";

// Context Builder
export * from "./context/index.js";

// Compact helpers
export * from "./compact/index.js";

// Memory paths
export { resolveProjectMemoryRoot } from "./memory/project-root.js";

// Tool components
export { ToolScheduler, defaultToolScheduler, READ_ONLY_TOOLS } from "./tool/scheduler.js";
export type { ToolSchedule, ToolScheduleItem, ToolDependency } from "./tool/scheduler.js";
export { createToolRegistry, ToolRegistry, ToolRegistryImpl } from "./tool/registry.js";
export { createToolExecutor, ToolExecutor, ToolExecutorImpl } from "./tool/executor.js";
export { builtInTools, registerBuiltInTools } from "./tool/handlers/index.js";
export {
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  resolveBashTimeoutPolicy,
} from "./tool/bash-timeout-policy.js";
export type { BashTimeoutPolicy } from "./tool/bash-timeout-policy.js";
export type {
  ToolMetadata,
  ToolHandler,
  ToolExecutionContext,
  ToolEntry,
  ToolExecutionResult,
  ToolResultSerialization,
  ToolBatchResult,
  ExecutableToolCall,
  ToolBatchEvent,
} from "./tool/types.js";

// Hooks
export * from "./hooks/index.js";

// MCP components
export * from "./mcp/index.js";

// Plugin 对话引用（@ Plugin capability hint）
export * from "./plugin-reference/index.js";

// Node REPL/browser-use plugin runtime primitives
export { NodeReplSession } from "./repl/node-repl-session.js";
export type {
  NodeReplCuaAppIdentity,
  NodeReplImage,
  NodeReplRequestMeta,
  NodeReplRunResult,
  NodeReplStructuredResult,
  NodeReplSessionOptions,
} from "./repl/node-repl-session.js";
export { setupBrowserRuntime } from "./browser-client/index.js";
export type { BrowserClientTransport } from "./browser-client/index.js";

// Subagent components
export * from "./subagent/index.js";

// Runtime task components
export * from "./runtime-task/index.js";

// Permission components
export {
  DenyPermissionBroker,
  ManualPermissionBroker,
  PermissionService,
  createDenyPermissionBroker,
  createManualPermissionBroker,
  defaultPermissionConfig,
} from "./permission/index.js";
export type {
  ManualPermissionBrokerOptions,
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission/index.js";
export type { PermissionConfig } from "./permission/index.js";

// Runtime
export { AgentRuntime } from "./runtime.js";
export { createExternalTurnFaultError } from "./runtime/helpers/turn-errors.js";
export { repairPersistedRemoteSessionPaths } from "./runtime/helpers/persisted-remote-session-path-repair.js";
// 「按值把一段转录复制进另一个会话」的克隆器：新会话用本地 id 续写，
// parentID / part 内嵌锚点随之重映射。导出而不是让调用方再写一份，是因为漏掉任何一处重映射的
// 症状（悬空 parentID、指向父会话的锚点）离成因都很远。
export { cloneMessageForFork, clonePartForFork } from "./runtime/helpers/steering.js";
export type {
  ChildClientPortsContext,
  ClientFacingPorts,
} from "./runtime/helpers/child-client-ports.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  TurnResult,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
  RuntimeFactory,
} from "./runtime.js";

// Output helpers
export { color, formatJson, supportsColor } from "./output.js";

// Environment helpers
export { getRuntimeInfo } from "./environment.js";
export type { RuntimeInfo } from "./environment.js";

export type {
  Logger,
  LoggerFactory,
  LogContext,
  LogEntry,
  SessionEvent,
  SessionEventSink,
} from "@zcode/contracts";
export { LogLevel, SessionEventType } from "@zcode/contracts";
