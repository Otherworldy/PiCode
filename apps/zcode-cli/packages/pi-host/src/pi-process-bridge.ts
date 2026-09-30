import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";

export const PI_PROCESS_WORK_PREFIX = "pi-process:";

const OUTPUT_LIMIT = 8192;
const KILL_TIMEOUT_MS = 8000;

type ProcessRow = {
  id: string;
  name: string;
  command: string;
  status: string;
  startTime: number;
  success: boolean | null;
  exitCode: number | null;
  endReason: string | null;
};

type ProcessBus = Pick<ExtensionAPI["events"], "emit" | "on">;

export type PiProcessBridge = {
  factories: InlineExtension[];
  subscribe(listener: (works: BackgroundWorkSummary[]) => void): () => void;
  kill(id: string): Promise<boolean>;
  output(workId: string): Promise<BackgroundBashOutputResult>;
};

export function piProcessId(workId: string): string | undefined {
  return workId.startsWith(PI_PROCESS_WORK_PREFIX)
    ? workId.slice(PI_PROCESS_WORK_PREFIX.length)
    : undefined;
}

export function toManagedProcessWorks(rows: readonly ProcessRow[]): BackgroundWorkSummary[] {
  return rows
    .filter((row) => row.status === "running" || row.status === "terminating")
    .map((row) => ({
      workId: `${PI_PROCESS_WORK_PREFIX}${row.id}`,
      kind: "bash" as const,
      title: row.name && row.name !== row.command ? `${row.name}: ${row.command}` : row.command,
      status: "running" as const,
      startedAt: row.startTime,
      cancellable: true,
      anchorRowId: null,
    }));
}

function ask<T>(bus: ProcessBus, channel: string, payload: Record<string, unknown>): T | undefined {
  let value: T | undefined;
  let seen = false;
  bus.emit(channel, {
    ...payload,
    reply: (next: T) => {
      seen = true;
      value = next;
    },
  });
  return seen ? value : undefined;
}

function outputStatus(info: ProcessRow): "running" | "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error" {
  if (info.status === "running" || info.status === "terminating") return "running";
  if (info.endReason === "spawn_error") return "spawn_error";
  if (info.status === "killed") return "cancelled";
  if (info.status === "terminate_timeout") return "timed_out";
  if (info.success === false || (info.exitCode != null && info.exitCode !== 0)) return "failed";
  return "completed";
}

/** 插件的事件总线不在会话对象上。这个 inline extension 和 pi-processes 用同一条总线。 */
export function createPiProcessBridge(): PiProcessBridge {
  let bus: ProcessBus | undefined;
  let latest: BackgroundWorkSummary[] = [];
  const listeners = new Set<(works: BackgroundWorkSummary[]) => void>();

  const refresh = () => {
    if (!bus) return;
    const rows = ask<ProcessRow[]>(bus, "processes:request:list", {}) ?? [];
    latest = toManagedProcessWorks(rows);
    for (const listener of listeners) listener(latest);
  };

  return {
    factories: [
      {
        name: "picode-processes",
        hidden: true,
        factory(pi) {
          bus = pi.events;
          pi.events.on("processes:changed", refresh);
          refresh();
        },
      },
    ],
    subscribe(listener) {
      listeners.add(listener);
      listener(latest);
      return () => listeners.delete(listener);
    },
    kill(id) {
      if (!bus) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), KILL_TIMEOUT_MS);
        bus?.emit("processes:command:kill", {
          id,
          reply: (result: { ok?: boolean }) => {
            clearTimeout(timer);
            resolve(result?.ok === true);
          },
        });
      });
    },
    output(workId) {
      const id = piProcessId(workId);
      if (!id || !bus) return Promise.resolve({ kind: "unavailable" as const, workId });
      const info = ask<ProcessRow | null>(bus, "processes:request:get", { id });
      if (!info) return Promise.resolve({ kind: "unavailable" as const, workId });
      const lines =
        ask<Array<{ text: string }>>(bus, "processes:request:combined_output", {
          id,
          tailLines: 200,
        }) ?? [];
      const files = ask<{ combinedFile?: string; stdoutFile?: string } | null>(
        bus,
        "processes:request:log_files",
        { id },
      );
      const text = lines.map((line) => line.text).join("");
      return Promise.resolve({
        kind: "output" as const,
        workId,
        status: outputStatus(info),
        output: text.slice(-OUTPUT_LIMIT),
        truncated: text.length > OUTPUT_LIMIT,
        outputPath: files?.combinedFile || files?.stdoutFile || "pi-process",
      });
    },
  };
}
