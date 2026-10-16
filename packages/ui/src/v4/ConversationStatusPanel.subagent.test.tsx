import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "./ConversationStatusPanel.js";

const TASK_TITLE = "Repo: D:/Study/Code/Github/ZCode (TypeScript monorepo)";

function renderPanel(children: ReactNode) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

function runningWork(): BackgroundWorkSummary {
  return {
    workId: "child-1",
    kind: "subagent",
    title: TASK_TITLE,
    status: "running",
    startedAt: 1_700_000_000_000,
    cancellable: true,
    anchorRowId: null,
    childSessionId: "child-1",
  };
}

describe("ConversationStatusPanel subagents", () => {
  it("shows the role, an icon stop, and opens the directory from the section title", () => {
    const html = renderPanel(
      <ConversationStatusPanel
        workspacePath="D:/Study/Code/Github/ZCode"
        summaryPanelVariantOverride="panel"
        agentSectionOpen
        parentSessionId="parent"
        rootSessionId="root"
        endedSubagentCount={4}
        onOpenSubagentDirectory={() => undefined}
        onCancelBackgroundWork={() => undefined}
        backgroundWorks={[runningWork()]}
        runningSubagents={[
          {
            childSessionId: "child-1",
            subagentType: "scout",
            title: TASK_TITLE,
            status: "running",
            startedAt: 1_700_000_000_000,
          },
        ]}
      />,
    );

    expect(html).toContain("scout");
    expect(html).not.toContain("TypeScript monorepo");
    expect(html).toContain('data-subagent-directory-trigger="section-title"');
    expect(html).toContain('aria-label="打开子智能体目录"');
    expect(html).toContain('data-size="icon-sm"');
    expect(html).not.toContain(">停止<");
  });

  it("keeps the section title as the expand control when the directory cannot open", () => {
    const html = renderPanel(
      <ConversationStatusPanel
        workspacePath="D:/Study/Code/Github/ZCode"
        summaryPanelVariantOverride="panel"
        agentSectionOpen
        onCancelBackgroundWork={() => undefined}
        backgroundWorks={[runningWork()]}
        runningSubagents={[
          {
            childSessionId: "child-1",
            subagentType: "researcher",
            title: TASK_TITLE,
            status: "running",
            startedAt: 1_700_000_000_000,
          },
        ]}
      />,
    );

    expect(html).toContain("researcher");
    expect(html).not.toContain("data-subagent-directory-trigger");
    expect(html).toContain('data-status-section-trigger="agent"');
  });
});
