import type { InlineExtension, McpServerConfig } from "@earendil-works/pi-coding-agent";

const WAIT_MS = 30_000;
const POLL_MS = 50;

export function chromeDevtoolsNamespace(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function lazyChromeDevtoolsPrompt(servers: readonly { name: string }[]): string {
  const names = servers.map((server) => chromeDevtoolsNamespace(server.name)).join(", ");
  return `MCP servers ${names} (codemode) are not running yet. The first codemode script that names one starts it. A global searchTools() does not.`;
}

/** 只有点名 chrome-devtools 才启动。全局搜工具会扫到 tdx，不能因此把浏览器拉起来。 */
export function chromeDevtoolsToolWantsServer(toolName: string, input: unknown): boolean {
  if (/mcp__chrome[-_]devtools/i.test(toolName)) return true;
  if (toolName !== "codemode" && toolName !== "tool_search") return false;
  return /chrome[-_]devtools/i.test(toolInputText(input));
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return [record.code, record.query, record.namespace, record.name]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function createLazyChromeDevtoolsExtension(
  servers: readonly { name: string; config: McpServerConfig }[],
): InlineExtension {
  return {
    name: "picode-lazy-chrome-devtools",
    hidden: true,
    factory(pi) {
      let pending: Promise<void> | undefined;
      pi.on("tool_call", async (event) => {
        if (servers.length === 0 || !chromeDevtoolsToolWantsServer(event.toolName, event.input)) {
          return undefined;
        }
        pending ??= ensureLazyChromeDevtools(pi, servers).catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
        try {
          await pending;
          return undefined;
        } catch (error) {
          return {
            block: true,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      });
    },
  };
}

export async function ensureLazyChromeDevtools(
  pi: {
    registerMcpServer(name: string, config: McpServerConfig): void;
    getAllTools(): ReadonlyArray<{ name: string }>;
  },
  servers: readonly { name: string; config: McpServerConfig }[],
  wait: {
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  } = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  },
): Promise<void> {
  for (const server of servers) {
    try {
      pi.registerMcpServer(server.name, server.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already registered")) throw error;
    }
  }
  const deadline = wait.now() + WAIT_MS;
  const prefixes = servers.map((server) => `${chromeDevtoolsNamespace(server.name)}__`);
  while (wait.now() < deadline) {
    const names = pi.getAllTools().map((tool) => tool.name);
    if (prefixes.every((prefix) => names.some((name) => name.startsWith(prefix)))) return;
    await wait.sleep(POLL_MS);
  }
  throw new Error("chrome-devtools MCP 在 30 秒内没有连上");
}
