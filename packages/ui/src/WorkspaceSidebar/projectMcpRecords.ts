import {
  convertToZCodeAgentMcpServer,
  type McpServerConfig,
  type NativeMcpServerRecord,
  type SaveCliMcpToUserDirectoryRequest,
  type SettingsDirectoryLocation,
  type ZCodeAgentMcpServer,
  type ZCodeMcpServer,
} from "@zcode/shared";

function projectMcpServerId(record: NativeMcpServerRecord): string {
  return `project-mcp:${record.projectPath ?? ""}:${record.name}`;
}

/**
 * 侧栏只编辑 Pi 项目文件 `.pi/mcp.json`。
 * 同一次 load 还会带回全局条目，以及 `.pi` 为空时的 `.agents/mcp.json` 回退；
 * 那些不是这个按钮的事实来源。
 */
export function selectProjectMcpRecords(
  records: readonly NativeMcpServerRecord[],
): NativeMcpServerRecord[] {
  return records.filter(
    (record) =>
      record.scope === "workspace" && (!record.location || record.location.source === "zcode"),
  );
}

export function toProjectMcpServers(records: readonly NativeMcpServerRecord[]): ZCodeMcpServer[] {
  return selectProjectMcpRecords(records).map((record) => ({
    id: projectMcpServerId(record),
    name: record.name,
    config: record.config,
    enabled: record.enabled !== false,
    status: "unknown",
    source: record.source,
    scope: "workspace",
    projectPath: record.projectPath,
    location: record.location,
    file: record.file,
  }));
}

/** 启用是缺省，不把 `enabled: true` 写进文件；停用只认 `enabled: false`。 */
export function projectMcpConfig(config: McpServerConfig, enabled: boolean): McpServerConfig {
  const { enabled: _enabled, enable: _legacyEnable, ...rest } = config;
  if (enabled) return rest;
  return { ...rest, enabled: false };
}

export function projectMcpSaveRequest(input: {
  action: SaveCliMcpToUserDirectoryRequest["action"];
  name: string;
  projectPath: string;
  config?: McpServerConfig;
  enabled?: boolean;
  location?: SettingsDirectoryLocation;
}): SaveCliMcpToUserDirectoryRequest {
  return {
    action: input.action,
    source: "zcodeagentmcp",
    name: input.name,
    projectPath: input.projectPath,
    ...(input.config ? { config: input.config } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.action === "set-enabled" && input.location ? { location: input.location } : {}),
  };
}

/** 先写入新名字，再删旧名字。同名只写一次。 */
export function projectMcpUpsertPlan(input: {
  previousName?: string;
  nextName: string;
  projectPath: string;
  config: McpServerConfig;
}): SaveCliMcpToUserDirectoryRequest[] {
  const name = input.nextName.trim();
  const writes = [
    projectMcpSaveRequest({
      action: "upsert",
      name,
      projectPath: input.projectPath,
      config: input.config,
    }),
  ];
  if (input.previousName && input.previousName !== name) {
    writes.push(
      projectMcpSaveRequest({
        action: "delete",
        name: input.previousName,
        projectPath: input.projectPath,
      }),
    );
  }
  return writes;
}

/**
 * mcp/list 的 connect 会按这次下发的集合 replace。
 * 只带项目条目会断开同一池里的用户级服务器，所以这里带上本次读到的全部已启用条目。
 */
export function mcpServersForProjectStatusProbe(
  records: readonly NativeMcpServerRecord[],
  workspacePath: string,
): ZCodeAgentMcpServer[] {
  const servers: ZCodeAgentMcpServer[] = [];
  for (const record of records) {
    if (record.enabled === false || record.source !== "zcodeagentmcp") continue;
    const inWorkspace =
      record.scope === "user" ||
      (record.scope === "workspace" && record.projectPath === workspacePath);
    if (!inWorkspace) continue;
    const server = convertToZCodeAgentMcpServer(record.name, record.config);
    if (server) servers.push(server);
  }
  return servers;
}

export function mcpProjectionMatchesWorkspace(
  current: { projectPath: string; workspaceIdentity?: string },
  target: { projectPath: string; workspaceIdentity?: string },
): boolean {
  if (!current.projectPath || !target.projectPath) return false;
  return (
    current.projectPath === target.projectPath &&
    (current.workspaceIdentity?.trim() || undefined) ===
      (target.workspaceIdentity?.trim() || undefined)
  );
}
