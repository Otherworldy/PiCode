import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import {
  embeddedBrowserOpenRequests,
  publishEmbeddedBrowserOpens,
  registerEmbeddedBrowserOpener,
} from "./embeddedBrowserOpen.js";

const scope = {
  workspacePath: "D:/work",
  workspaceIdentity: " remote-1 ",
  remoteSessionId: "rs",
  sessionId: "session",
};

test("only http review urls become built-in browser opens", () => {
  const deltas = [
    { op: "embeddedBrowser.open", url: "http://127.0.0.1:9/review" },
    { op: "embeddedBrowser.open", url: "javascript:alert(1)" },
    { op: "row.delta", rowId: 1, path: "text", append: "x" },
  ] as ConversationDelta[];
  assert.deepEqual(embeddedBrowserOpenRequests(deltas, scope), [
    {
      url: "http://127.0.0.1:9/review",
      disposition: "foreground-tab",
      workspaceKey: "remote-1",
      sessionId: "session",
      remoteSessionId: "rs",
    },
  ]);
});

test("publish uses the registered opener", () => {
  const seen: string[] = [];
  const unregister = registerEmbeddedBrowserOpener((request) => {
    seen.push(request.url);
  });
  try {
    publishEmbeddedBrowserOpens(
      [{ op: "embeddedBrowser.open", url: "https://localhost/review" } as ConversationDelta],
      { workspacePath: "D:/work", sessionId: "session" },
    );
    assert.deepEqual(seen, ["https://localhost/review"]);
  } finally {
    unregister();
  }
});
