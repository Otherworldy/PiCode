const FAMILY_NAMES: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  powershell: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

const SUBAGENT_NAMES = new Set(["agent", "task", "subagent", "pi-subagent"]);

export function mapPiToolName(piName: string | undefined, viaRegistry = false): string {
  // Pi 的 toolcall_start 经常还没有名字。trim 崩了会把整个 agent 进程打掉。
  const key = (piName ?? "").trim();
  if (!key) return "Tool";
  const mapped = FAMILY_NAMES[key.toLowerCase()];
  if (mapped) return mapped;
  if (viaRegistry && SUBAGENT_NAMES.has(key.toLowerCase())) return "Agent";
  return key;
}

export function toolResultText(result: { content?: Array<{ text?: string }> } | undefined): string {
  if (!result?.content) return "";
  return result.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

export function editDisplay(details: Record<string, unknown> | undefined): unknown {
  if (!details) return undefined;
  const filePath = typeof details.path === "string" ? details.path : undefined;
  const patch = typeof details.patch === "string" ? details.patch : undefined;
  const diff = typeof details.diff === "string" ? details.diff : patch;
  if (!filePath || !diff) return undefined;
  const lines = diff.split("\n");
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: deletions,
        newStart: 1,
        newLines: additions,
        lines,
      },
    ],
  };
}

export function bashDisplay(text: string, details?: Record<string, unknown>): unknown {
  const truncated = details?.truncation != null || details?.truncated === true;
  const outputPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
  return {
    kind: "bash_output",
    output: text.slice(0, 150_000),
    truncated: Boolean(truncated),
    ...(outputPath ? { outputPath } : {}),
  };
}
