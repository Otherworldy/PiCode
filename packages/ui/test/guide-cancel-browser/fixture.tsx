import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationSnapshot } from "@picode/shared/picode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";

const context = {
  workspacePath: "guide-cancel-browser",
  theme: "dark" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
function App() {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  async function command(action: string, input = {}) {
    const response = await fetch(`/${action}`, { method: "POST", body: JSON.stringify(input) });
    const data = await response.json();
    setSnapshot(data.snapshot);
    setStatus(data.result);
    return response.ok;
  }
  return (
    <main>
      <h1>引导取消交互回归</h1>
      <label>
        引导正文
        <input
          aria-label="引导正文"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button
        onClick={() => {
          void command("send", { text }).then((ok) => {
            if (ok) setText("");
          });
        }}
      >
        发送引导
      </button>
      <button
        onClick={() => {
          void command("release");
        }}
      >
        继续当前运行
      </button>
      <button
        onClick={() => {
          void command("snapshot");
        }}
      >
        重新读取快照
      </button>
      <label>
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(event) => setReadOnly(event.target.checked)}
        />
        只读
      </label>
      <p role="status">{status}</p>
      {snapshot ? (
        <>
          <ConversationPendingGuideList
            context={context}
            turnId="fixture"
            items={snapshot.queue.items}
            onCancel={
              readOnly
                ? undefined
                : (queueItemId) => {
                    void command("cancel", { queueItemId });
                  }
            }
          />
          {snapshot.rows.window
            .filter((row) => row.kind === "userInput" && row.sourceCommandId !== "initial")
            .map((row) => (
              <ConversationTurnRow key={row.rowId} row={row} context={context} />
            ))}
        </>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
