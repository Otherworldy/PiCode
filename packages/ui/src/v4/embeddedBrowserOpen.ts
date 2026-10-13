import type { EmbeddedBrowserOpenUrlRequest } from "@zcode/shared";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";

export interface EmbeddedBrowserOpenScope {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
}

let opener: ((request: EmbeddedBrowserOpenUrlRequest) => void) | null = null;

export function registerEmbeddedBrowserOpener(
  open: (request: EmbeddedBrowserOpenUrlRequest) => void,
): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function embeddedBrowserOpenRequests(
  deltas: readonly ConversationDelta[],
  scope: EmbeddedBrowserOpenScope,
): EmbeddedBrowserOpenUrlRequest[] {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  const requests: EmbeddedBrowserOpenUrlRequest[] = [];
  for (const delta of deltas) {
    if (delta.op !== "embeddedBrowser.open" || !isHttpUrl(delta.url)) continue;
    requests.push({
      url: delta.url,
      disposition: "foreground-tab",
      workspaceKey,
      sessionId: scope.sessionId,
      ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
    });
  }
  return requests;
}

export function publishEmbeddedBrowserOpens(
  deltas: readonly ConversationDelta[],
  scope: EmbeddedBrowserOpenScope,
): void {
  if (!opener) return;
  for (const request of embeddedBrowserOpenRequests(deltas, scope)) opener(request);
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
