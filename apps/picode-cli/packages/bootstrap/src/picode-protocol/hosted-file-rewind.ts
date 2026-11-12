import type {
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@picode/shared/picode-protocol-v4";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  planSuffixFileRewind,
  planTurnFileRewind,
  readProcessSshRemoteSpec,
  sshReadText,
  sshRemoveFile,
  sshWriteText,
  suffixTurnIds,
  summarizeTurnFileChanges,
  type HostedSession,
} from "@picode/pi-host";
import { remotePosixPath } from "@picode/shared/node";
import { type TurnId } from "@picode/contracts";

const emptyRewind = {
  preview: { canApply: false, ignoredFiles: [], safeFiles: [], unsafeFiles: [] },
  restores: [] as Array<{ path: string; content: string }>,
  deletes: [] as string[],
};

async function rewindTurnFiles(hosted: HostedSession, turnId: TurnId | undefined) {
  if (!turnId) return emptyRewind;
  return planTurnFileRewind(hosted.projector.getSnapshot().rows.window, String(turnId), (path) =>
    readTurnFile(hosted, path),
  );
}

/** 回退到此处：锚点 turn 及之后所有 turn 一起撤销。 */
async function rewindSuffixFiles(hosted: HostedSession, anchorTurnId: string | undefined) {
  if (!anchorTurnId) return emptyRewind;
  return planSuffixFileRewind(hosted.projector.getSnapshot().rows.window, anchorTurnId, (path) =>
    readTurnFile(hosted, path),
  );
}

function rewindFilePlan(
  hosted: HostedSession,
  options?: { expandSuffix?: boolean; targetTurnId?: TurnId },
) {
  const anchorTurnId = options?.targetTurnId ? String(options.targetTurnId) : undefined;
  return options?.expandSuffix
    ? rewindSuffixFiles(hosted, anchorTurnId)
    : rewindTurnFiles(hosted, options?.targetTurnId);
}

function absoluteTurnPath(hosted: HostedSession, filePath: string): string {
  // 工具路径相对实际执行目录，worktree/子目录不能回退 workspace 根目录的同名文件。
  return isAbsolute(filePath) ? filePath : resolve(hosted.cwd, filePath);
}

async function readTurnFile(hosted: HostedSession, filePath: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  try {
    if (spec) {
      const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
      return { content: await sshReadText(spec, remote) };
    }
    return { content: await readFile(absoluteTurnPath(hosted, filePath), "utf8") };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || /no such file/i.test(message)) return { missing: true as const };
    return { error: message };
  }
}

async function writeTurnFile(hosted: HostedSession, filePath: string, content: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  if (spec) {
    const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
    await sshWriteText(spec, remote, content);
    return;
  }
  await writeFile(absoluteTurnPath(hosted, filePath), content, "utf8");
}

async function removeTurnFile(hosted: HostedSession, filePath: string) {
  const spec = readProcessSshRemoteSpec(hosted.workspacePath);
  if (spec) {
    const remote = remotePosixPath(absoluteTurnPath(hosted, filePath), spec.remotePath);
    await sshRemoveFile(spec, remote);
    return;
  }
  await rm(absoluteTurnPath(hosted, filePath), { force: true });
}

export function describeHostedTurnFileChanges(
  hosted: HostedSession,
  turnId: string,
): V4ConversationFileChangesResult | null {
  const summary = summarizeTurnFileChanges(hosted.projector.getSnapshot().rows.window, turnId);
  if (!summary) return null;
  const header = hosted.projector
    .getSnapshot()
    .rows.window.find((row) => row.kind === "turnHeader" && row.turnId === turnId);
  return {
    ...summary,
    ...(header && header.kind === "turnHeader" && header.fileChanges?.state
      ? { state: header.fileChanges.state }
      : {}),
  };
}
export async function previewHostedWorkspaceFileRewind(
  hosted: HostedSession,
  options?: {
    expandSuffix?: boolean;
    targetTurnId?: TurnId;
  },
): Promise<V4ConversationFileRewindPreviewResult> {
  return (await rewindFilePlan(hosted, options)).preview;
}
export async function applyHostedWorkspaceFileRewind(
  hosted: HostedSession,
  options?: {
    expandSuffix?: boolean;
    targetTurnId?: TurnId;
    commitAfterApply?: () => Promise<void>;
  },
): Promise<{ applied: boolean; preview: V4ConversationFileRewindPreviewResult; response: string }> {
  const anchorTurnId = options?.targetTurnId ? String(options.targetTurnId) : "";
  const revertedTurnIds = options?.expandSuffix
    ? anchorTurnId
      ? suffixTurnIds(hosted.projector.getSnapshot().rows.window, anchorTurnId)
      : []
    : anchorTurnId
      ? [anchorTurnId]
      : [];
  const plan = await rewindFilePlan(hosted, options);
  if (!plan.preview.canApply) {
    return {
      applied: false,
      preview: plan.preview,
      response: "File rewind was not applied because at least one file is unsafe.",
    };
  }
  const journal: Array<{ path: string; content: string | null; deleted: boolean }> = [];
  try {
    for (const file of plan.restores) {
      const current = await readTurnFile(hosted, file.path);
      const previous =
        "content" in current && typeof current.content === "string" ? current.content : null;
      journal.push({ path: file.path, content: previous, deleted: false });
      await writeTurnFile(hosted, file.path, file.content);
    }
    for (const path of plan.deletes) {
      const current = await readTurnFile(hosted, path);
      const previous =
        "content" in current && typeof current.content === "string" ? current.content : null;
      journal.push({ path, content: previous, deleted: true });
      await removeTurnFile(hosted, path);
    }
    await options?.commitAfterApply?.();
    for (const turnId of revertedTurnIds) hosted.markTurnFilesReverted(turnId);
  } catch (error) {
    try {
      for (const entry of [...journal].reverse()) {
        if (entry.deleted) {
          if (entry.content !== null) await writeTurnFile(hosted, entry.path, entry.content);
          continue;
        }
        if (entry.content === null) continue;
        await writeTurnFile(hosted, entry.path, entry.content);
      }
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        "Workspace file rewind failed and compensation was incomplete",
      );
    }
    return {
      applied: false,
      preview: { ...plan.preview, canApply: false },
      response: error instanceof Error ? error.message : String(error),
    };
  }
  return { applied: true, preview: plan.preview, response: "" };
}
