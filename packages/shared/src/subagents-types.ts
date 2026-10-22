import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export const BUILT_IN_SUBAGENT_NAMES = [
  "scout",
  "researcher",
  "evidence-auditor",
  "worker",
  "reviewer",
  "oracle",
  "delegate",
] as const;

export type BuiltInSubagentName = (typeof BUILT_IN_SUBAGENT_NAMES)[number];

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

/** 内置角色的工具覆盖。没有 key 就是继承角色默认工具。 */
export interface BuiltInSubagentToolOverride {
  /** 省略 = 角色默认；`inherit` = 全部 Pi 内置工具；数组（可为空）= 白名单。 */
  tools?: string[] | "inherit";
  /** 在 `tools` 解析之后减掉的工具名。 */
  excludeTools?: string[];
}

export type BuiltInSubagentToolOverrides = Partial<
  Record<BuiltInSubagentName, BuiltInSubagentToolOverride>
>;

const BUILT_IN_SUBAGENT_NAME_SET = new Set<string>(BUILT_IN_SUBAGENT_NAMES);

/** 只保留当前内置角色的正式选择。旧的 general-purpose / Explore 覆盖不再套到新角色上。 */
export function parseBuiltInSubagentModelSelectionOverrides(
  value: unknown,
): BuiltInSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: BuiltInSubagentModelSelectionOverrides = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!BUILT_IN_SUBAGENT_NAME_SET.has(name)) continue;
    const selection = modelSelectionSchema.safeParse(candidate);
    if (selection.success) result[name as BuiltInSubagentName] = selection.data;
  }
  return result;
}

/** 与模型覆盖同一套宽容度：不认识的键、非字符串条目一律丢掉；空数组是有效值（= 无工具）。 */
export function parseBuiltInSubagentToolOverrides(value: unknown): BuiltInSubagentToolOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: BuiltInSubagentToolOverrides = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!BUILT_IN_SUBAGENT_NAME_SET.has(name)) continue;
    const parsed = parseToolOverrideEntry(candidate);
    if (parsed) result[name as BuiltInSubagentName] = parsed;
  }
  return result;
}

function parseToolOverrideEntry(candidate: unknown): BuiltInSubagentToolOverride | undefined {
  // 早期写入的是裸数组，读时仍接受。
  if (Array.isArray(candidate)) {
    return { tools: parseToolNameList(candidate) };
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as { tools?: unknown; excludeTools?: unknown };
  const tools =
    record.tools === "inherit"
      ? ("inherit" as const)
      : Array.isArray(record.tools)
        ? parseToolNameList(record.tools)
        : undefined;
  const excludeTools = Array.isArray(record.excludeTools)
    ? parseToolNameList(record.excludeTools)
    : undefined;
  if (tools === undefined && excludeTools === undefined) return undefined;
  return {
    ...(tools !== undefined ? { tools } : {}),
    ...(excludeTools !== undefined ? { excludeTools } : {}),
  };
}

function parseToolNameList(value: readonly unknown[]): string[] {
  const tools = value
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  return [...new Set(tools)];
}

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  /** 只在有工具覆盖时出现；`tools` 始终是生效列表，`["*"]` 表示全部内置工具。 */
  toolsOverride?: string[];
  /** 覆盖里在解析后减掉的工具名。 */
  toolsExclude?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

/** `tools` 为 null 时删掉覆盖；`"inherit"` 表示全部 Pi 内置工具；空数组表示无工具。 */
export interface BuiltInSubagentToolOverrideParams {
  agentName: BuiltInSubagentName;
  tools: string[] | "inherit" | null;
  excludeTools?: string[];
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
