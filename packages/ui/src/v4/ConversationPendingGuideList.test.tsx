import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueueItem } from "@picode/shared/picode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { Locale } from "@picode/shared";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationPendingGuideList } from "./ConversationPendingGuideList.js";

function pendingGuide(
  queueItemId: string,
  text: string,
  options: { steerState?: "submitting" | "steering"; cancelSettlementPending?: boolean } = {},
): QueueItem {
  return {
    sourceCommandId: `cmd_${queueItemId}`,
    queueItemId,
    clientId: "desktop",
    kind: "sendText",
    text,
    attachments: [],
    delivery: { requested: "guide", admitted: "guide" },
    order: { admissionSeq: 2 },
    steer: { state: options.steerState ?? "steering" },
    dispatch: { state: "reserved" },
    ...(options.cancelSettlementPending ? { cancelSettlementPending: true } : {}),
    admittedAt: 1_700_000_000_000,
  } as unknown as QueueItem;
}

function context(): ConversationRowRenderContext {
  return {
    workspacePath: "D:/Study/Code/Github/ZCode",
    theme: "dark",
    codePreviewSettings: undefined,
    sessionId: "session-1",
  } as unknown as ConversationRowRenderContext;
}

function render(node: ReactElement, locale: Locale = "zh-CN") {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <TooltipProvider>{node}</TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("ConversationPendingGuideList 取消引导", () => {
  it("每条待生效 GUIDE 都常驻一个可访问的取消按钮", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[pendingGuide("queue_cmd_a", "先看后端"), pendingGuide("queue_cmd_b", "再看前端")]}
        turnId="turn-1"
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("先看后端");
    expect(html).toContain("再看前端");
    expect(html.match(/data-v4-pending-guide-cancel="queue_cmd_[ab]"/g)).toEqual([
      'data-v4-pending-guide-cancel="queue_cmd_a"',
      'data-v4-pending-guide-cancel="queue_cmd_b"',
    ]);
    expect(html.match(/aria-label="取消引导"/g)).toHaveLength(2);
    expect(html).toContain(">取消引导</button>");
  });

  it("只读视图（无 onCancel）只渲染待生效条目，不提供入口", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[pendingGuide("queue_cmd_a", "先看后端")]}
        turnId="turn-1"
      />,
    );

    expect(html).toContain("先看后端");
    expect(html).not.toContain("data-v4-pending-guide-cancel");
    expect(html).not.toContain("取消引导");
  });

  it("submitting 阶段暂不提供取消入口", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[pendingGuide("queue_cmd_a", "正在准入", { steerState: "submitting" })]}
        turnId="turn-1"
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("正在准入");
    expect(html).not.toContain("data-v4-pending-guide-cancel");
  });

  it("账本收口失败后提供重试入口和明确状态", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[
          pendingGuide("queue_cmd_a", "稍后重试", {
            cancelSettlementPending: true,
          }),
        ]}
        turnId="turn-1"
        onCancel={() => undefined}
      />,
    );

    expect(html).toContain("取消未确认，请重试收口");
    expect(html).toContain('aria-label="重试取消"');
    expect(html).toContain(">重试取消</button>");
  });

  it("英文界面使用 Cancel guide", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[pendingGuide("queue_cmd_a", "backend first")]}
        turnId="turn-1"
        onCancel={() => undefined}
      />,
      "en-US",
    );

    expect(html).toContain('aria-label="Cancel guide"');
    expect(html).toContain(">Cancel guide</button>");
  });

  it("没有待生效条目时不渲染列表", () => {
    const html = render(
      <ConversationPendingGuideList
        context={context()}
        items={[]}
        turnId="turn-1"
        onCancel={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
