import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerSessionStats, deriveSessionStats } from "@/v4/ComposerSessionStats.js";

type Cumulative = SessionUsageState["cumulative"];

function cumulative(overrides: Partial<Cumulative> = {}): Cumulative {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    ...overrides,
  };
}

function render(value: Cumulative): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ComposerSessionStats cumulative={value} />
    </ZCodeIntlProvider>,
  );
}

describe("ComposerSessionStats", () => {
  it("空会话什么都不画", () => {
    expect(render(cumulative())).toBe("");
  });

  it("轮次与步数写在一行里", () => {
    const html = render(cumulative({ turns: 3, steps: 4 }));
    expect(html).toContain("3 轮 4 步");
    expect(html).toContain('data-testid="composer-session-stats"');
  });

  it("token 总量按四项相加，不给缓存读单独算", () => {
    // 1 500 未缓存 + 86 016 缓存读 + 239 输出 = 87 755。
    const html = render(
      cumulative({
        inputTokens: 1_505,
        cacheReadTokens: 86_016,
        cacheWriteTokens: 0,
        outputTokens: 239,
        turns: 1,
        steps: 1,
      }),
    );
    expect(html).toContain("87.8K tok");
    expect(html).toContain("缓存命中 98%");
  });

  it("缓存写入进分母：写了缓存就没命中满", () => {
    // 100 未缓存 + 0 读 + 900 写：命中率 0%，不是 null 也不是 100%。
    const html = render(
      cumulative({ inputTokens: 100, cacheWriteTokens: 900, outputTokens: 10, steps: 1 }),
    );
    expect(html).toContain("缓存命中 0%");
  });

  it("分母为 0 时不写命中率那一段", () => {
    // 只有输出没有 prompt 侧用量：命中率没有定义，不能补一个 0%。
    const html = render(cumulative({ outputTokens: 1_200, steps: 1 }));
    expect(html).toContain("1.2K tok");
    expect(html).not.toContain("缓存命中");
  });

  it("没有耗时数据时会话 pill 是纯文本，点不出空面板", () => {
    const html = render(cumulative({ turns: 3, steps: 4 }));
    expect(html).toContain("3 轮 4 步");
    expect(html).toContain('data-testid="composer-session-activity"');
    expect(html).not.toContain("模型用时");
  });

  it("纯文本分支也要 flex 排版，否则图标与文字会折成两行", () => {
    // 裸 span 是 inline 元素，h-6/gap/items-center 全不生效，实测会断行。
    const html = render(cumulative({ turns: 3, steps: 4 }));
    const className =
      /<span class="([^"]*)" data-testid="composer-session-activity"/u.exec(html)?.[1] ?? "";
    expect(className).toContain("inline-flex");
    expect(className).toContain("whitespace-nowrap");
  });

  it("有耗时数据时可点，四项与 dsh 同口径", () => {
    const value = cumulative({
      turns: 1,
      steps: 1,
      llmMs: 12_500,
      toolMs: 3_000,
      ttftMs: 2_400,
      ttftSteps: 2,
      decodeMs: 9_300,
      decodeTokens: 930,
    });
    // 弹窗内容走 Portal，静态渲染里拿不到，所以断言派生值与「可点」这两个事实。
    expect(render(value)).not.toContain('data-testid="composer-session-activity"');
    const derived = deriveSessionStats(value);
    // 首 token 平均 = 2400ms / 2 步 = 1.2s，不是总时长。
    expect(derived.ttftAverage).toBe(1_200);
    // 速度只算解码段：930 token / 9.3s = 100 tok/s，不拿总时长当分母。
    // 浮点除法在这里会有尾数误差，按近似比较。
    expect(derived.speed).toBeCloseTo(100, 6);
  });

  it("速度进 pill 标签，与轮步用同一个分隔符", () => {
    const html = render(
      cumulative({ turns: 2, steps: 3, decodeMs: 1_000, decodeTokens: 42, llmMs: 5_000 }),
    );
    expect(html).toContain("2 轮 3 步");
    expect(html).toContain("42 tok/s");
  });
});
