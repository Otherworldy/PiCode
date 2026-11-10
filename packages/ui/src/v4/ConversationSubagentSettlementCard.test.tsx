import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationSubagentSettlementCard } from "./ConversationSubagentSettlementCard.js";

function row(overrides: Partial<AssistantTextRow> = {}): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId: 7,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 7,
    text: '子代理 "reviewer" 已完成。\nchildSessionId: child-1\n\n报告正文',
    state: "complete",
    subagentSettlement: {
      agent: "reviewer",
      status: "success",
      childSessionId: "child-1",
      text: "报告正文",
    },
    ...overrides,
  };
}

function context(overrides: Partial<ConversationRowRenderContext> = {}) {
  return {
    workspacePath: "D:/workspace",
    theme: "dark",
    codePreviewSettings: undefined,
    sessionId: "parent-1",
    rootSessionId: "root-1",
    onOpenSubagentSession: () => undefined,
    ...overrides,
  } as unknown as ConversationRowRenderContext;
}

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{node}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("后台子代理结算卡片", () => {
  it("按工具卡画：子智能体 + 角色名 + 状态，正文收在展开区", () => {
    const html = render(<ConversationSubagentSettlementCard row={row()} context={context()} />);

    expect(html).toContain("子智能体");
    expect(html).toContain("reviewer");
    expect(html).toContain("已完成");
    expect(html).toContain("lucide-bot");
    // 正文是展开区内容，收起态不该把它铺在摘要行上。
    expect(html).not.toContain("childSessionId:");
  });

  it("角色名是打开子会话详情的入口", () => {
    const html = render(<ConversationSubagentSettlementCard row={row()} context={context()} />);

    expect(html).toContain('data-testid="v4-subagent-open-side-pane-child-1"');
    expect(html).toContain('aria-label="在右侧打开"');
  });

  it("没有子会话 id 时不给右侧入口", () => {
    const html = render(
      <ConversationSubagentSettlementCard
        row={row({
          subagentSettlement: {
            agent: "reviewer",
            status: "success",
            text: "报告正文",
          },
        })}
        context={context()}
      />,
    );

    expect(html).not.toContain("v4-subagent-open-side-pane");
    expect(html).toContain("reviewer");
  });

  it("失败态带失败状态词", () => {
    const html = render(
      <ConversationSubagentSettlementCard
        row={row({
          subagentSettlement: {
            agent: "reviewer",
            status: "failed",
            childSessionId: "child-1",
            text: "boom",
          },
        })}
        context={context()}
      />,
    );

    expect(html).toContain("失败");
  });
});
