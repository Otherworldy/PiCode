import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { FallbackToolCallBlock } from "./fallback.js";
import { SubagentToolCallBlock } from "./subagent.js";

function makeContext(kind: string, input: unknown): ToolCallBlockRenderContext {
  const toolCall = { toolId: "t1", kind, status: "in_progress", input } as never;
  return {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "D:/workspace",
    displayModel: buildToolDisplayModel(toolCall, "D:/workspace"),
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: true,
    statusLabel: "执行中",
    childToolList: null,
    theme: "dark",
  };
}

function render(node: ReactElement) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{node}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("picode_subagent 摘要行", () => {
  it("显示派发的角色名，不显示 wire 名、扳手和兜底的「工具调用」", () => {
    const html = render(
      <SubagentToolCallBlock
        {...makeContext("picode_subagent", { agent: "reviewer", task: "复核改动" })}
      />,
    );

    expect(html).toContain("子智能体");
    expect(html).toContain("reviewer");
    expect(html).toContain("lucide-bot");
    expect(html).not.toContain("工具调用");
    expect(html).not.toContain("Picode_subagent");
    expect(html).not.toContain("lucide-wrench");
  });

  it("流式输入还没读到角色时只留「子智能体」", () => {
    const html = render(<SubagentToolCallBlock {...makeContext("picode_subagent", {})} />);

    expect(html).toContain("子智能体");
    expect(html).not.toContain("工具调用");
  });

  it("其它未知工具仍走原兜底卡", () => {
    const html = render(<FallbackToolCallBlock {...makeContext("weird_tool", { a: 1 })} />);

    expect(html).toContain("工具调用");
    expect(html).toContain("lucide-wrench");
  });
});
