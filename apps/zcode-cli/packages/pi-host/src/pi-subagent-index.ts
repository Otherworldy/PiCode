import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readPiJsonl } from "./jsonl-history.js";
import { getLiveSubagentAgentName, hasLiveSubagent } from "./live-subagents.js";

export type PiSubagentPanelStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "success"
  | "failed"
  | "cancelled"
  | "lost";

export type PiSubagentChild = {
  childSessionId: string;
  sessionFile?: string;
  subagentType: string;
  title: string;
  summary?: string;
  status: PiSubagentPanelStatus;
  startedAt?: number;
  endedAt?: number;
};

const WALK_DEPTH = 4;
const WALK_LIMIT = 200;

function fileStem(file: string): string {
  return basename(file).replace(/\.jsonl$/u, "");
}

/** `picode_subagent` 的 jsonl 只属于父会话目录，不能进左侧会话列表。 */
export function isPicodeSubagentSessionFile(sessionFile: string): boolean {
  return sessionFile.split(/[\\/]/u).includes("picode-subagent");
}

/** Pi 文件名是 `timestamp_<sessionId>.jsonl`。没有时间戳前缀时整段就是 id。 */
export function sessionIdFromPiJsonlName(fileName: string): string {
  const stem = basename(fileName).replace(/\.jsonl$/u, "");
  const matched = stem.match(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_(.+)$/u);
  return matched?.[1] || stem;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapRunState(state: unknown): PiSubagentPanelStatus {
  if (state === "running" || state === "queued" || state === "starting") return "running";
  if (state === "paused" || state === "waiting") return "waiting";
  if (state === "blocked" || state === "needs_attention") return "blocked";
  if (state === "failed" || state === "partial") return "failed";
  if (state === "stopped" || state === "cancelled") return "cancelled";
  if (state === "complete" || state === "completed") return "success";
  return "lost";
}

async function walkJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length >= WALK_LIMIT) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= WALK_LIMIT || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, depth - 1, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

async function readStatusFiles(parentSessionId: string, stemDir: string): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  let tempEntries;
  try {
    tempEntries = await readdir(tmpdir(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of tempEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith("pi-subagents-")) continue;
    const runsDir = join(tmpdir(), entry.name, "async-subagent-runs");
    let runs;
    try {
      runs = await readdir(runsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const raw = await readFile(join(runsDir, run.name, "status.json"), "utf8").catch(() => "");
      if (!raw) continue;
      try {
        const parsed = asRecord(JSON.parse(raw));
        if (!parsed) continue;
        const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
        const sessionFile = typeof parsed.sessionFile === "string" ? parsed.sessionFile : "";
        if (sessionId !== parentSessionId && !sessionFile.startsWith(stemDir)) continue;
        found.push(parsed);
      } catch {
        // skip malformed status
      }
    }
  }
  return found;
}

function firstStep(status: Record<string, unknown>): Record<string, unknown> | undefined {
  return Array.isArray(status.steps) ? asRecord(status.steps[0]) ?? undefined : undefined;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;

function agentName(value: string): string {
  const name = value.trim();
  return name && name !== "subagent" && AGENT_NAME.test(name) ? name : "";
}

/**
 * 更早的子会话没有 `.role`。内置角色的系统提示第一句是 `You are <name>.`，
 * 这是当时写进文件的唯一角色名。
 */
export function subagentRoleFromSessionText(content: string): string {
  return agentName(/You are ([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})\./u.exec(content)?.[1] ?? "");
}

async function readRoleFile(sessionFile: string): Promise<string> {
  const raw = await readFile(`${sessionFile}.role`, "utf8").catch(() => "");
  return agentName(raw);
}

function roleFromSources(...values: readonly string[]): string {
  for (const value of values) {
    const name = agentName(value);
    if (name) return name;
  }
  return "subagent";
}

export function piSubagentRevision(children: readonly PiSubagentChild[]): number {
  if (children.length === 0) return 0;
  let revision = 1;
  for (const child of children) {
    revision = (revision * 33 + child.childSessionId.length + child.status.length) >>> 0;
  }
  return Math.max(1, revision);
}

export async function listPiSubagentChildren(input: {
  parentSessionFile: string;
  parentSessionId: string;
}): Promise<PiSubagentChild[]> {
  const stem = fileStem(input.parentSessionFile);
  const parentDir = dirname(input.parentSessionFile);
  const stemDir = join(parentDir, stem);
  const files: string[] = [];
  // 子会话目录名是父文件去掉 .jsonl。Pi 实际文件名和注册表预拼的文件名时间戳不同，
  // 所以同一 session id 可能有一个没被用到的兄弟目录，两边都要扫。
  const names = await readdir(parentDir).catch(() => [] as string[]);
  for (const name of names) {
    if (name !== stem && !name.endsWith(`_${input.parentSessionId}`)) continue;
    const dir = join(parentDir, name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    await walkJsonl(dir, WALK_DEPTH, files);
  }
  const byFile = new Map<string, PiSubagentChild>();
  for (const file of files) {
    const content = await readFile(file, "utf8").catch(() => "");
    const summary = readPiJsonl(content).summary;
    if (!summary) continue;
    const childSessionId = summary.sessionId || fileStem(file);
    const fileStat = await stat(file).catch(() => undefined);
    const fresh = fileStat ? Date.now() - fileStat.mtimeMs < 4000 && !summary.lastAssistantPreview : false;
    byFile.set(file, {
      childSessionId,
      sessionFile: file,
      subagentType: roleFromSources(
        getLiveSubagentAgentName(childSessionId),
        await readRoleFile(file),
        subagentRoleFromSessionText(content),
      ),
      title: summary.title || fileStem(file),
      ...(summary.lastAssistantPreview ? { summary: summary.lastAssistantPreview } : {}),
      status: fresh ? "running" : summary.lastAssistantPreview ? "success" : "running",
      startedAt: summary.createdAt,
      ...(fresh ? {} : { endedAt: summary.lastActivityAt }),
    });
  }
  for (const status of await readStatusFiles(input.parentSessionId, stemDir)) {
    const step = firstStep(status);
    const sessionFile =
      (typeof step?.sessionFile === "string" && step.sessionFile) ||
      (typeof status.sessionFile === "string" ? status.sessionFile : "");
    const existing = sessionFile ? byFile.get(sessionFile) : undefined;
    const runId = typeof status.runId === "string" ? status.runId : "";
    const description = typeof step?.description === "string" ? step.description : undefined;
    const mapped = mapRunState(step?.status ?? status.state);
    const startedAt = typeof status.startedAt === "number" ? status.startedAt : existing?.startedAt;
    const endedAt = typeof status.endedAt === "number" ? status.endedAt : undefined;
    const childSessionId = existing?.childSessionId || runId || fileStem(sessionFile);
    const subagentType = roleFromSources(
      typeof step?.agent === "string" ? step.agent : "",
      getLiveSubagentAgentName(childSessionId),
      existing?.subagentType ?? "",
    );
    const next: PiSubagentChild = {
      childSessionId,
      ...(sessionFile ? { sessionFile } : {}),
      subagentType,
      title:
        existing?.title && existing.title !== existing.childSessionId ? existing.title : subagentType,
      ...(description ? { summary: description } : existing?.summary ? { summary: existing.summary } : {}),
      status: mapped,
      ...(startedAt ? { startedAt } : {}),
      ...(mapped === "running" || mapped === "waiting" || mapped === "blocked"
        ? {}
        : { endedAt: endedAt ?? existing?.endedAt }),
    };
    if (!next.childSessionId) continue;
    byFile.set(sessionFile || next.childSessionId, next);
  }
  return [...byFile.values()].map(applyLiveChild);
}

/** 文件启发式会把没正文的记成在跑、把已有正文的记成完成。活表才是还在不在。 */
function applyLiveChild(child: PiSubagentChild): PiSubagentChild {
  if (hasLiveSubagent(child.childSessionId)) {
    if (child.status === "waiting" || child.status === "blocked") return child;
    if (child.status === "running" && child.endedAt === undefined) return child;
    const { endedAt: _endedAt, ...open } = child;
    return { ...open, status: "running" };
  }
  if (child.status !== "running" && child.status !== "waiting" && child.status !== "blocked") {
    return child;
  }
  const endedAt = child.endedAt ?? child.startedAt;
  return { ...child, status: "success", ...(endedAt ? { endedAt } : {}) };
}
