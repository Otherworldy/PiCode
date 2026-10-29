/**
 * MCP 连接/子进程的内存注册表。
 *
 * 这不是遥测：桌面 Host 的资源管理器用 `listProcesses()` 把 `ps` 进程树上的 pid
 * 归到具体 server 与插件名下（`process/childProcesses` 协议方法），否则所有 CLI
 * 后代都会被归成一类。注册表只记录内存事实，不做 I/O、不发事件、不采样本。
 */

/** `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined */
export function resolvePluginName(serverName: string): string | undefined {
  if (!serverName.startsWith("plugin:")) return undefined;
  const name = serverName.slice("plugin:".length).split(":")[0]?.trim();
  return name ? name : undefined;
}

export type McpProcessSource = "builtin" | "plugin" | "custom";

/** 归属用的最小进程事实；不出本机，无需脱敏。 */
export interface McpTrackedProcess {
  pid: number;
  serverName: string;
  mcpSource: McpProcessSource;
  /** `plugin:<name>:<key>` 命名空间里的插件名；builtin host MCP（node_repl）由调用方按官方插件表补齐 */
  pluginName?: string;
}

interface TrackedConnection {
  connectionId: string;
  serverName: string;
  mcpSource: McpProcessSource;
  pid?: number;
}

export interface McpProcessRegistry {
  registerConnection(input: {
    connectionId: string;
    serverName: string;
    source?: McpProcessSource;
  }): void;
  unregisterConnection(input: { connectionId: string }): void;
  recordProcessStarted(input: { connectionId: string; pid: number }): void;
  recordProcessClosed(input: { connectionId: string }): void;
  /** 当前仍有存活进程记录的 MCP 连接（纯内存，无 I/O） */
  listProcesses(): McpTrackedProcess[];
}

export function createMcpProcessRegistry(): McpProcessRegistry {
  const connections = new Map<string, TrackedConnection>();

  return {
    registerConnection({ connectionId, serverName, source }) {
      connections.set(connectionId, {
        connectionId,
        serverName,
        mcpSource: source ?? "custom",
      });
    },
    unregisterConnection({ connectionId }) {
      connections.delete(connectionId);
    },
    recordProcessStarted({ connectionId, pid }) {
      const connection = connections.get(connectionId);
      if (connection) connection.pid = pid;
    },
    recordProcessClosed({ connectionId }) {
      const connection = connections.get(connectionId);
      if (connection) delete connection.pid;
    },
    listProcesses() {
      const processes: McpTrackedProcess[] = [];
      for (const connection of connections.values()) {
        if (connection.pid === undefined) continue;
        const pluginName = resolvePluginName(connection.serverName);
        processes.push({
          pid: connection.pid,
          serverName: connection.serverName,
          mcpSource: connection.mcpSource,
          ...(pluginName ? { pluginName } : {}),
        });
      }
      return processes;
    },
  };
}
