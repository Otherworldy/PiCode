import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

const STARTED_AT = 1_000;
/** 整轮净工时 14 分 6 秒，与 bug 现场的顶部计时同口径。 */
const TURN_ACTIVE_MS = 846_000;
const TRIGGER_PREFIX = "chat-assistant-history-trigger-";
const LABEL_OPEN = '<span class="truncate">';

function runningHeader(overrides: Partial<TurnHeaderRow> = {}): ConversationRow {
  const header: TurnHeaderRow = {
    rowId: 1,
    turnId: "t1",
    createdAt: STARTED_AT,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "running",
    startedAt: STARTED_AT,
    ...overrides,
  };
  return header;
}

function toolRow(rowId: number, startedAt: number, endedAt: number): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: startedAt,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "bash",
    status: "success",
    inputText: "echo hi",
    startedAt,
    endedAt,
  };
}

function textRow(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: STARTED_AT + rowId * 1_000,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "继续",
    state: "complete",
  };
}

/** 第一块（早就结束）+ 正文 + 第二块（此刻正在跑）。 */
function twoChunkRows(): ConversationRow[] {
  return [
    runningHeader(),
    toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400),
    textRow(3),
    toolRow(4, STARTED_AT + 840_000, STARTED_AT + 845_000),
  ];
}

function renderTurn(rows: readonly ConversationRow[], nowMs = STARTED_AT + TURN_ACTIVE_MS): string {
  const unit = buildConversationTurnRenderUnits(rows, { nowMs, sessionPhase: "running" })[0];
  if (!unit) throw new Error("missing render unit");
  const context: ConversationRowRenderContext = {
    workspacePath: "D:/Study/Code/Github/ZCode",
    theme: "dark",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  };
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ConversationTurnGroup unit={unit} context={context} />
    </ZCodeIntlProvider>,
  );
}

function triggerLabel(html: string, key: string): string {
  const start = html.indexOf(`${TRIGGER_PREFIX}${key}"`);
  if (start < 0) throw new Error(`missing trigger ${key}`);
  const labelStart = html.indexOf(LABEL_OPEN, start);
  return html.slice(labelStart + LABEL_OPEN.length, html.indexOf("</span>", labelStart));
}

describe("工作块折叠标题的工时口径", () => {
  it("整轮还在跑时，只有当前工作块带「工作中」和累计秒数", () => {
    const html = renderTurn(twoChunkRows());

    // 顶部那一块早就结束了：只报这次工具调用，不再顶着整轮累计工时走秒。
    expect(triggerLabel(html, "t1")).toBe("调用 1 次工具");
    // 计时跟着正在工作的那一块走，和轮尾 loading 同口径。
    expect(triggerLabel(html, "t1:chunk-1")).toBe("工作中 14 分 6 秒 · 调用 1 次工具");
    expect(html).toContain("工作中，用时 14 分 6 秒");
  });

  it("顶部已结束的块不随时间走秒", () => {
    const early = triggerLabel(renderTurn(twoChunkRows(), STARTED_AT + 60_000), "t1");
    const late = triggerLabel(renderTurn(twoChunkRows()), "t1");

    expect(early).toBe("调用 1 次工具");
    expect(late).toBe(early);
  });

  it("轮结束后计时停住，每块只报自己的工具数和跨度", () => {
    const html = renderTurn([
      runningHeader({ state: "completedSuccess", endedAt: STARTED_AT + TURN_ACTIVE_MS }),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400),
      textRow(3),
      toolRow(4, STARTED_AT + 840_000, STARTED_AT + 845_000),
    ]);

    expect(html).not.toContain("工作中");
    expect(triggerLabel(html, "t1")).toBe("调用 1 次工具");
    expect(triggerLabel(html, "t1:chunk-1")).toBe("调用 1 次工具，工作 5 秒");
  });

  it("还没有工具块时，状态行仍跟着整轮工时走", () => {
    const html = renderTurn([runningHeader(), textRow(2)]);

    // 没有可折叠块可切，这一行就是整轮唯一的工作状态：必须还是「工作中」，不能退回「已工作」。
    expect(triggerLabel(html, "t1")).toBe("工作中 14 分 6 秒");
  });
});
