import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

const STARTED_AT = 1_000;
/** 整轮净工时 14 分 6 秒，与 bug 现场的顶部计时同口径。 */
const TURN_ACTIVE_MS = 846_000;
const TRIGGER_PREFIX = "chat-assistant-history-trigger-";
const LABEL_OPEN = /<span class="truncate[^"]*">/;

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

function toolRow(
  rowId: number,
  startedAt: number,
  endedAt: number,
  options: { toolName?: string; status?: "inputStreaming" | "running" | "success" | "error" } = {},
): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: startedAt,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: options.toolName ?? "bash",
    status: options.status ?? "success",
    inputText: "echo hi",
    startedAt,
    endedAt,
  };
}

function reasoningRow(rowId: number, startedAt: number): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: startedAt,
    createdAtSeq: rowId,
    kind: "reasoning",
    text: "先看看项目结构",
    state: "streaming",
  };
}

function emptyReasoningRow(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: STARTED_AT + rowId * 1_000,
    createdAtSeq: rowId,
    kind: "reasoning",
    text: "",
    state: "complete",
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
    toolRow(4, STARTED_AT + 840_000, STARTED_AT + 845_000, { status: "running" }),
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
  const rest = html.slice(start);
  const match = LABEL_OPEN.exec(rest);
  if (!match) throw new Error(`missing label ${key}`);
  const labelStart = start + match.index + match[0].length;
  return html.slice(labelStart, html.indexOf("</span>", labelStart));
}

/** 标题元素本身的 HTML：只有它带 aria-expanded 与箭头。 */
function triggerHtml(html: string, key: string): string {
  const start = html.indexOf(`${TRIGGER_PREFIX}${key}"`);
  if (start < 0) throw new Error(`missing trigger ${key}`);
  return html.slice(start, html.indexOf("</button>", start));
}

/** 标题右侧有没有折叠箭头：有箭头才表示这块可以收起。 */
function triggerHasChevron(html: string, key: string): boolean {
  return triggerHtml(html, key).includes("lucide-chevron-right");
}

/** 轮尾那行运行态的可见文字：图标本身没有文本，只取带扫光的那一段。 */
function loadingSlotLabel(html: string): string {
  const start = html.indexOf('data-testid="chat-loading"');
  if (start < 0) throw new Error("missing loading slot");
  const match = /<span class="[^"]*zcode-working-shimmer[^"]*">/.exec(html.slice(start));
  if (!match) throw new Error("missing loading label");
  const textStart = start + match.index + match[0].length;
  return html.slice(textStart, html.indexOf("</span>", textStart));
}

/**
 * 一个动作备几条同义文案，标题按块和工时轮换。
 * 断言只认「这一组里的一条」，不锁死具体第几条，否则轮换一动测试就红。
 */
function expectActivity(html: string, key: string, activity: string): void {
  const labels = [1, 2, 3].map((n) => zhCN[`chat.workChunk.activity.${activity}.${n}`]);
  expect(labels).toContain(triggerLabel(html, key));
}

/** 轮尾那行的整段 HTML：从包住它的 span 开始，含外层文字色类。 */
function loadingSlotHtml(html: string): string {
  const marker = html.indexOf('data-testid="chat-loading"');
  if (marker < 0) throw new Error("missing loading slot");
  const start = html.lastIndexOf("<span class=", marker);
  return html.slice(start, html.indexOf("</div>", marker));
}

describe("工作块折叠标题的工时口径", () => {
  it("整轮还在跑时，工作块标题报当前动作，工时和次数只报在轮尾", () => {
    const html = renderTurn(twoChunkRows());

    // 跑着的那一块报当前动作，不报工时和次数。
    expectActivity(html, "t1:chunk-1", "commands");
    // 默认展开，箭头随时可点：运行中也能收起。
    expect(triggerHtml(html, "t1:chunk-1")).toContain('aria-expanded="true"');
    expect(triggerHasChevron(html, "t1:chunk-1")).toBe(true);
    // 顶部那一块早就结束了：只报这次工具调用，不再顶着整轮累计工时走秒。
    expect(triggerLabel(html, "t1")).toBe("调用 1 次工具");
    // 轮尾按整轮累计：转圈图标 + 净工时 + 两次工具调用，不再写「工作中」。
    expect(loadingSlotLabel(html)).toBe("用时 14 分 6 秒 · 调用 2 次工具");
    expect(html).not.toContain("工作中");
    // 文字仍走中性扫光（与工作块标题同一套色阶），图标实色转圈。
    const slot = loadingSlotHtml(html);
    expect(slot).toContain("zcode-working-shimmer");
    expect(slot).not.toContain("zcode-working-shimmer-run");
    expect(slot).toContain("text-foreground-subtle");
    expect(slot).toContain("animate-spin");
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

    expect(html).not.toContain("chat-loading");
    expect(triggerLabel(html, "t1")).toBe("调用 1 次工具");
    expect(triggerLabel(html, "t1:chunk-1")).toBe("调用 1 次工具，工作 5 秒");
    // 结束后块默认收起，但标题仍可点开。
    expect(triggerHtml(html, "t1")).toContain('aria-expanded="false"');
    expect(triggerHasChevron(html, "t1:chunk-1")).toBe(true);
  });

  it("块内最后一条在思考时，标题报「正在思考」", () => {
    const html = renderTurn([runningHeader(), reasoningRow(2, STARTED_AT + 1_000)]);

    expectActivity(html, "t1", "thinking");
  });

  it("工具后面的空思考行不把标题带成「正在思考」", () => {
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, { toolName: "Read" }),
      emptyReasoningRow(3),
    ]);

    // 空的 reasoning block 不渲染，也不能把标题从工具动作改成「正在思考」。
    expectActivity(html, "t1", "read");
  });

  it("工具还在跑时，后面跟着的思考行不抢走标题", () => {
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, { toolName: "Read", status: "running" }),
      reasoningRow(3, STARTED_AT + 2_000),
    ]);

    expectActivity(html, "t1", "read");
  });

  it("explore 子工具已经落定时，标题仍报它的动作", () => {
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, { toolName: "Grep" }),
      toolRow(3, STARTED_AT + 2_000, STARTED_AT + 2_400, { toolName: "Read" }),
    ]);

    // 父阶段还在跑，子工具先 success：报的是读文件，不是退回去说思考。
    expectActivity(html, "t1", "read");
  });

  it("同一块跑久了会换一句，同一个工时不会抖", () => {
    const at = (elapsedMs: number) =>
      triggerLabel(renderTurn(twoChunkRows(), STARTED_AT + elapsedMs), "t1:chunk-1");

    // 同一个工时重算两次得到同一句：轮换不能取随机数，否则每秒重渲染都在闪。
    expect(at(10_000)).toBe(at(10_000));
    // 跑过一个轮换周期就换一句。
    expect(at(18_000)).not.toBe(at(10_000));
  });

  it("连着跑三个周期，三句都轮得到", () => {
    const seen = new Set(
      [0, 1, 2].map((step) =>
        triggerLabel(renderTurn(twoChunkRows(), STARTED_AT + 10_000 + step * 8_000), "t1:chunk-1"),
      ),
    );

    expect(seen.size).toBe(3);
  });

  it("参数还在流时标题说「准备」，不是「正在」", () => {
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, {
        toolName: "Read",
        status: "inputStreaming",
      }),
    ]);

    expect(triggerLabel(html, "t1")).toBe("准备读取文件");
  });

  it("不同工具报不同动作", () => {
    const grep = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, { toolName: "Grep", status: "running" }),
    ]);
    expectActivity(grep, "t1", "search");

    const agent = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, { toolName: "Agent", status: "running" }),
    ]);
    expectActivity(agent, "t1", "subagents");
  });

  it("没登记的工具名回退成「正在调用工具」", () => {
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400, {
        toolName: "SomeUnknownTool",
        status: "running",
      }),
    ]);

    expectActivity(html, "t1", "tools");
  });

  it("还没有工具块时，状态行报当前动作，统计只在轮尾", () => {
    const html = renderTurn([runningHeader(), textRow(2)]);

    // 没有可折叠块可切：这一行只报动作，不报工时和次数。
    expectActivity(html, "t1", "answer");
    // 这一轮没有工具调用：轮尾只剩时长。
    expect(loadingSlotLabel(html)).toBe("用时 14 分 6 秒");
  });

  it("process 通知留在同一块里当状态行，不切开工作区也不上屏原始 XML", () => {
    const notice: ConversationRow = {
      rowId: 3,
      turnId: "t1",
      createdAt: STARTED_AT + 2_000,
      createdAtSeq: 3,
      kind: "assistantText",
      text: '<process_event type="log_match" kind="log_match">\n  <summary>Process "dev" matched log pattern "ready" on stdout.</summary>\n  <matched_line>ready</matched_line>\n</process_event>',
      state: "complete",
    };
    const html = renderTurn([
      runningHeader(),
      toolRow(2, STARTED_AT + 1_000, STARTED_AT + 1_400),
      notice,
      toolRow(4, STARTED_AT + 840_000, STARTED_AT + 845_000, { status: "running" }),
    ]);

    // 还是同一块：没有因为通知再切一个「调用 N 次工具」出来。
    expect(html).toContain(`${TRIGGER_PREFIX}t1"`);
    expect(html).not.toContain(`${TRIGGER_PREFIX}t1:chunk-1"`);
    // 只画 summary，且带自己的图标列。
    expect(html).toContain("matched log pattern &quot;ready&quot; on stdout.");
    expect(html).toContain("lucide-activity");
    // 原始 XML 不上屏。
    expect(html).not.toContain("process_event");
    expect(html).not.toContain("matched_line");
  });
});
