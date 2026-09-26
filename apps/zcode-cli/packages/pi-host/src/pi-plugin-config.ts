import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

export type PiPluginConfigValue = boolean | number | string;

export type PiPluginConfigField = {
  key: string;
  type: "boolean" | "number" | "string";
  value: PiPluginConfigValue;
  sensitive: boolean;
};

export type PiPluginConfigView = {
  id: string;
  name: string;
  fields: PiPluginConfigField[];
  skipped: string[];
};

const ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const SENSITIVE_KEY = /api[-_]?key|token|secret|password|credential/iu;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configFile(agentDir: string, id: string): string {
  if (id === "." || id === ".." || !ID_PATTERN.test(id)) {
    throw new Error(`Unknown Pi plugin config "${id}"`);
  }
  const root = resolve(agentDir, "extensions");
  const dir = resolve(root, id);
  if (relative(root, dir) !== id) throw new Error(`Unknown Pi plugin config "${id}"`);
  return join(dir, "config.json");
}

function fieldOf(key: string, value: unknown): PiPluginConfigField | null {
  if (typeof value === "boolean") {
    return { key, type: "boolean", value, sensitive: false };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { key, type: "number", value, sensitive: false };
  }
  if (typeof value === "string") {
    return { key, type: "string", value, sensitive: SENSITIVE_KEY.test(key) };
  }
  return null;
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export async function listPiPluginConfigs(agentDir = piAgentDir()): Promise<PiPluginConfigView[]> {
  const root = join(agentDir, "extensions");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const configs: PiPluginConfigView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(configFile(agentDir, entry.name), "utf8")) as unknown;
    } catch {
      continue;
    }
    const record = asObject(parsed);
    if (!record) continue;
    const fields: PiPluginConfigField[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      const field = fieldOf(key, value);
      if (field) fields.push(field);
      else skipped.push(key);
    }
    if (fields.length === 0) continue;
    configs.push({ id: entry.name, name: entry.name, fields, skipped });
  }
  configs.sort((a, b) => a.name.localeCompare(b.name));
  return configs;
}

export async function writePiPluginConfig(
  id: string,
  values: Record<string, PiPluginConfigValue>,
  agentDir = piAgentDir(),
): Promise<void> {
  const file = configFile(agentDir, id);
  const record = asObject(JSON.parse(await readFile(file, "utf8")) as unknown);
  if (!record) throw new Error(`Unknown Pi plugin config "${id}"`);
  for (const [key, value] of Object.entries(values)) {
    const existing = record[key];
    if (typeof existing !== typeof value) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    record[key] = value;
  }
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
