import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  stripTodoStepEmphasis,
  TodoStepGlyph,
  todoStepTextClass,
  type TodoStepStatus,
} from "./TodoStepGlyph.js";

function render(status: TodoStepStatus) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TodoStepGlyph status={status} />
    </ZCodeIntlProvider>,
  );
}

describe("TodoStepGlyph", () => {
  it("paints a filled success disc for a finished step", () => {
    const html = render("completed");

    expect(html).toContain("bg-success");
    expect(html).toContain("rounded-full");
  });

  it("paints a hollow ring for a waiting step", () => {
    const html = render("pending");

    expect(html).toContain("border-foreground-subtle");
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain("todo-step-arc");
  });

  it("keeps the running ring the same outer size as the waiting ring", () => {
    // 2r + strokeWidth 必须等于 viewBox 边长，否则进行中的环比待办小一圈。
    const html = render("inProgress");
    const radius = /r="([\d.]+)"/.exec(html)?.[1];
    const strokeWidth = /stroke-width="([\d.]+)"/.exec(html)?.[1];

    expect(html).toContain('viewBox="0 0 14 14"');
    expect(Number(radius) * 2 + Number(strokeWidth)).toBe(14);
  });

  it("treats both in-progress spellings as the same running step", () => {
    const snapshotSpelling = render("inProgress");
    const toolSpelling = render("in_progress");

    expect(snapshotSpelling).toBe(toolSpelling);
    // 弧线本身存在，减少动效关掉动画后仍停在静态弧上，不会退化成待办的空环。
    expect(snapshotSpelling).toContain("todo-step-arc");
    expect(snapshotSpelling).toContain("todo-step-spin");
  });

  it("exposes the status to assistive technology instead of colour alone", () => {
    expect(render("completed")).toContain('aria-label="已完成"');
    expect(render("inProgress")).toContain('aria-label="进行中"');
    expect(render("pending")).toContain('aria-label="未开始"');
  });

  it("dims and strikes finished text while waiting text stays secondary", () => {
    expect(todoStepTextClass("completed")).toContain("line-through");
    expect(todoStepTextClass("completed")).toContain("text-foreground-subtlest");
    expect(todoStepTextClass("pending")).toBe("text-foreground-subtle");
    expect(todoStepTextClass("inProgress")).toBe(todoStepTextClass("in_progress"));
  });
});

describe("stripTodoStepEmphasis", () => {
  it("drops the emphasis markers models wrap whole steps in", () => {
    expect(stripTodoStepEmphasis("**Step 1: 后端路由与派生组核心逻辑改造**")).toBe(
      "Step 1: 后端路由与派生组核心逻辑改造",
    );
    expect(stripTodoStepEmphasis("__Step 2__")).toBe("Step 2");
    expect(stripTodoStepEmphasis("__注意__")).toBe("注意");
    expect(stripTodoStepEmphasis("  **a** 和 **b**  ")).toBe("a 和 b");
    expect(stripTodoStepEmphasis("**Step 1:** 说明")).toBe("Step 1: 说明");
  });

  it("leaves single markers and identifiers alone", () => {
    expect(stripTodoStepEmphasis("path/to/*.ts")).toBe("path/to/*.ts");
    expect(stripTodoStepEmphasis("改 src/**/*.ts")).toBe("改 src/**/*.ts");
    expect(stripTodoStepEmphasis("snake_case_name")).toBe("snake_case_name");
    // 下划线对是合法 Python 标识符，不能被当成强调。
    expect(stripTodoStepEmphasis("补 __init__ 和 __main__")).toBe("补 __init__ 和 __main__");
  });

  it("does not start a bold match inside a glob", () => {
    // 旧实现从 glob 里的 `**` 开始配对，会把路径和后面的强调一起吃坏。
    expect(stripTodoStepEmphasis("改 src/**/*.ts 和 **路由**")).toBe("改 src/**/*.ts 和 路由");
  });
});
