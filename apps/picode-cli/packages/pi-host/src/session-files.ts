import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { piCoding } from "./pi-sdk.js";
import { resolveSessionEntry } from "./session-tree.js";

function sessionFileHasContent(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export function branchPiSessionFile(
  sessionFile: string,
  entryId: string,
): { sessionId: string; sessionFile: string } {
  const manager = piCoding().SessionManager.open(sessionFile, dirname(sessionFile));
  // 画面上的 id 可能是消息 id。树节点是另一个 id，直接分支会 Entry not found。
  const resolved = resolveSessionEntry(manager, entryId) ?? entryId;
  if (manager.getEntry(resolved) == null) throw new Error(`Entry ${entryId} not found`);
  const branched = manager.createBranchedSession(resolved);
  if (!branched) throw new Error(`Entry ${entryId} not found`);
  return { sessionId: manager.getSessionId(), sessionFile: branched };
}

export function openOrCreateSession(input: {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  parentSessionId?: string;
}) {
  if (sessionFileHasContent(input.sessionFile)) {
    return piCoding().SessionManager.open(input.sessionFile, undefined, input.cwd);
  }
  return piCoding().SessionManager.create(input.cwd, dirname(input.sessionFile), {
    id: input.sessionId,
    parentSession: input.parentSessionId,
  });
}
