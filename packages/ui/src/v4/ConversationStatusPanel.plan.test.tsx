import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanState } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "./ConversationStatusPanel.js";

function plan(items: PlanState["items"]): PlanState {
  return { items, updatedAt: 1_700_000_000_000 };
}

function renderPlan(items: PlanState["items"]) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ConversationStatusPanel
          workspacePath="D:/Study/Code/Github/ZCode"
          summaryPanelVariantOverride="panel"
          plan={plan(items)}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("ConversationStatusPanel plan section", () => {
  it("summarizes progress per status instead of a bare fraction", () => {
    const html = renderPlan([
      { id: "1", content: "**Step 1: 后端路由与派生组核心逻辑改造**", status: "completed" },
      { id: "2", content: "后端模型验真身份对齐与智能归一化", status: "completed" },
      { id: "3", content: "前端模型验真页面与徽章适配", status: "inProgress" },
      { id: "4", content: "前端模型组管理", status: "pending" },
      { id: "5", content: "代码格式化与静态检查", status: "pending" },
    ]);

    expect(html).toContain("待办");
    expect(html).toContain("已完成 2");
    expect(html).toContain("进行中 1");
    expect(html).toContain("待处理 2");
    expect(html).not.toContain("2/5");
  });

  it("hides zero-count segments", () => {
    const html = renderPlan([
      { id: "1", content: "甲", status: "pending" },
      { id: "2", content: "乙", status: "pending" },
    ]);

    expect(html).toContain("待处理 2");
    expect(html).not.toContain("已完成");
    expect(html).not.toContain("进行中");
  });

  it("renders the shared status glyphs and strips emphasis markers", () => {
    const html = renderPlan([
      { id: "1", content: "**Step 1: 完成项**", status: "completed" },
      { id: "2", content: "**Step 2: 进行项**", status: "inProgress" },
      { id: "3", content: "**Step 3: 待办项**", status: "pending" },
    ]);

    expect(html).toContain('data-plan-status="completed"');
    expect(html).toContain("bg-success");
    expect(html).toContain("todo-step-arc");
    expect(html).toContain("border-foreground-subtle");
    expect(html).toContain("Step 1: 完成项");
    expect(html).not.toContain("**Step");
  });
});
