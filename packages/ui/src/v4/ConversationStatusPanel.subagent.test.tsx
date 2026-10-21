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

  it("shows the usage pill, token rate, and makeup bar for a live subagent", () => {
    const html = renderPanel(
      <ConversationStatusPanel
        workspacePath="D:/Study/Code/Github/ZCode"
        summaryPanelVariantOverride="panel"
        agentSectionOpen
        parentSessionId="parent"
        rootSessionId="root"
        onCancelBackgroundWork={() => undefined}
        onOpenSubagentSession={() => undefined}
        backgroundWorks={[runningWork()]}
        runningSubagents={[
          {
            childSessionId: "child-1",
            subagentType: "scout",
            title: TASK_TITLE,
            status: "running",
            startedAt: 1_700_000_000_000,
            usage: {
              inputTokens: 3_180,
              cacheReadTokens: 74_180,
              cacheWriteTokens: 0,
              outputTokens: 5_600,
              llmDurationMs: 200_000,
              ttftMs: 66_667,
            },
          },
        ]}
      />,
    );

    expect(html).toContain('data-running-subagent-usage-trigger="true"');
    expect(html).toContain('aria-expanded="false"');
    // 用量 pill 与「打开子会话」覆盖层是兄弟：pill 自己抬 z-index，点用量只展开明细。
    expect(html).toContain('data-running-subagent-session-trigger="true"');
    expect(html).toContain("pointer-events-auto relative z-[2] inline-flex h-6");
    // 总量走 turnTotalTokens：3.2K + 74.2K + 0 + 5.6K = 83K。
    expect(html).toContain(">83K<");
    expect(html).toContain(">42 tok/s<");
    expect(html).toContain("用量构成");
    // 明细默认收起，但仍在 DOM 里，靠 grid 的 0fr 行高隐藏。
    expect(html).toContain("grid-template-rows:0fr");
  });

  it("falls back to the waiting label when there is no usage yet", () => {
    const html = renderPanel(
      <ConversationStatusPanel
        workspacePath="D:/Study/Code/Github/ZCode"
        summaryPanelVariantOverride="panel"
        agentSectionOpen
        parentSessionId="parent"
        rootSessionId="root"
        onCancelBackgroundWork={() => undefined}
        backgroundWorks={[runningWork()]}
        runningSubagents={[
          {
            childSessionId: "child-1",
            subagentType: "tester",
            title: TASK_TITLE,
            status: "waiting",
            startedAt: 1_700_000_000_000,
          },
        ]}
      />,
    );

    expect(html).toContain("tester");
    expect(html).toContain("等待中");
    expect(html).not.toContain("data-running-subagent-usage-trigger");
  });
});
