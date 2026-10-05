import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Pi user MCP file. Honors `PI_CODING_AGENT_DIR`, else `~/.pi/agent/mcp.json`. */
export function piUserMcpFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "mcp.json");
}

export function piProjectMcpFile(cwd: string): string {
  return join(cwd, ".pi", "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One `mcpServers` entry for Pi.
 * `directTools: true` becomes `exposure: "direct"`; anything else stays Pi's default `codemode`.
 * SSE is dropped. Other fields are kept so official auth and the settings form can still read them.
 */
export function toPiStoredMcpServer(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "sse") return undefined;
  const value: Record<string, unknown> = { ...raw };
  if (value.type === "streamableHttp" || value.type === "streamable-http") value.type = "http";
  if (value.directTools === true && typeof value.exposure !== "string") value.exposure = "direct";
  delete value.directTools;
  if (typeof value.timeoutMs === "number" && typeof value.timeout !== "number") {
    value.timeout = Math.max(1, Math.ceil(value.timeoutMs / 1000));
  }
  return value;
}

export function mcpServersFromDocument(parsed: unknown, key: "mcpServers" | "mcp.servers"): Record<string, unknown> {
  if (!isRecord(parsed)) return {};
  if (key === "mcpServers") {
    return isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  }
  const mcp = parsed.mcp;
  if (!isRecord(mcp) || !isRecord(mcp.servers)) return {};
  return mcp.servers;
}

function readDocument(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeServers(path: string, servers: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = readDocument(path) ?? {};
  writeFileSync(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`, "utf8");
}

function importedMarker(target: string): string {
  return `${target}.zcode-imported`;
}

/**
 * Copy a legacy file once.
 * An existing Pi file with servers is left alone.
 * An empty one still receives the legacy servers (Pi may have created the file first).
 * ponytail: one marker file, not a second config. Delete the marker to import again.
 */
function migrateIfMissing(target: string, legacyPath: string, key: "mcpServers" | "mcp.servers"): void {
  const marker = importedMarker(target);
  if (existsSync(marker)) return;
  const existing = mcpServersFromDocument(readDocument(target), "mcpServers");
  if (Object.keys(existing).length > 0) {
    writeFileSync(marker, "");
    return;
  }
  const legacy = mcpServersFromDocument(readDocument(legacyPath), key);
  const servers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(legacy)) {
    const stored = toPiStoredMcpServer(config);
    if (stored) servers[name] = stored;
  }
  if (Object.keys(servers).length > 0) writeServers(target, servers);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
}

/**
 * Create the Pi files from the old PiCode config when they are missing.
 * A custom `agentDir` (tests) does not receive the real user file.
 */
export function ensurePiMcpFiles(input: { agentDir: string; cwd: string }): void {
  const userTarget = join(input.agentDir, "mcp.json");
  if (resolve(input.agentDir) === resolve(dirname(piUserMcpFile()))) {
    migrateIfMissing(userTarget, join(homedir(), ".PiCode", "cli", "config.json"), "mcp.servers");
  }
  migrateIfMissing(piProjectMcpFile(input.cwd), join(input.cwd, ".PiCode", "config.json"), "mcp.servers");
}

export function readPiMcpServers(agentDir: string, cwd: string): {
  projectWins: boolean;
  servers: Array<{ name: string; config: Record<string, unknown>; scope: "global" | "project" }>;
  errors: string[];
} {
  ensurePiMcpFiles({ agentDir, cwd });
  const errors: string[] = [];
  const merged = new Map<string, { name: string; config: Record<string, unknown>; scope: "global" | "project" }>();
  const take = (path: string, scope: "global" | "project") => {
    for (const [name, config] of Object.entries(mcpServersFromDocument(readDocument(path), "mcpServers"))) {
      if (!isRecord(config)) continue;
      if (config.type === "sse") {
        errors.push(`${name}: SSE is not supported`);
        continue;
      }
      merged.set(name, { name, config, scope });
    }
  };
  take(join(agentDir, "mcp.json"), "global");
  take(piProjectMcpFile(cwd), "project");
  return { projectWins: true, servers: [...merged.values()], errors };
}
