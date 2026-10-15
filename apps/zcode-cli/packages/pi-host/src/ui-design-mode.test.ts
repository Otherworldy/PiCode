import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyUiDesignConstraint,
  createUiDesignMode,
  isUiDesignWritePathAllowed,
  UI_DESIGN_CONSTRAINT,
  UI_DESIGN_NUDGE,
  uiDesignAnnotateTarget,
  uiDesignShouldContinue,
  uiDesignStartMessage,
  uiDesignToolDecision,
} from "./ui-design-mode.js";

const cwd = "D:/work/app";

test("html under designs is writable", () => {
  assert.equal(isUiDesignWritePathAllowed("designs/prompt-dialog.html", cwd), true);
  assert.equal(isUiDesignWritePathAllowed("designs/nested/a.htm", cwd), true);
  assert.equal(isUiDesignWritePathAllowed("designs/prompt-dialog.HTML", cwd), true);
  assert.equal(isUiDesignWritePathAllowed("D:/work/app/designs/prompt-dialog.html", cwd), true);
});

test("other paths and extensions are not writable", () => {
  assert.equal(isUiDesignWritePathAllowed("src/a.html", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("designs/notes.md", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("designs", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("../designs/a.html", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("designs/../src/a.html", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("D:/other/designs/a.html", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("", cwd), false);
  assert.equal(isUiDesignWritePathAllowed("   ", cwd), false);
});

test("tool gate stays open until the mode is on", () => {
  assert.equal(uiDesignToolDecision(false, "bash", {}, cwd), undefined);
  assert.equal(uiDesignToolDecision(false, "write", { path: "src/a.ts" }, cwd), undefined);
});

test("open mode blocks shells and non-html writes, and keeps annotate", () => {
  assert.equal(uiDesignToolDecision(true, "bash", { command: "ls" }, cwd)?.block, true);
  assert.equal(uiDesignToolDecision(true, "powershell", {}, cwd)?.block, true);
  assert.equal(uiDesignToolDecision(true, "read", { path: "SYSTEM.md" }, cwd), undefined);
  assert.equal(
    uiDesignToolDecision(true, "write", { path: "designs/prompt-dialog.html" }, cwd),
    undefined,
  );
  assert.equal(uiDesignToolDecision(true, "edit", { path: "src/a.ts" }, cwd)?.block, true);
  assert.equal(uiDesignToolDecision(true, "edit", { path: "designs/notes.md" }, cwd)?.block, true);
  assert.equal(uiDesignToolDecision(true, "plannotator", { action: "annotate" }, cwd), undefined);
});

test("a saved html file is the annotate target", () => {
  assert.equal(
    uiDesignAnnotateTarget(true, "write", false, { path: "designs/hello.html" }, cwd),
    "designs/hello.html",
  );
  assert.equal(
    uiDesignAnnotateTarget(true, "write", true, { path: "designs/hello.html" }, cwd),
    undefined,
  );
  assert.equal(
    uiDesignAnnotateTarget(true, "bash", false, { command: "ls" }, cwd),
    undefined,
  );
  assert.equal(
    uiDesignAnnotateTarget(false, "write", false, { path: "designs/hello.html" }, cwd),
    undefined,
  );
});

test("saving the html opens annotate", async () => {
  const opened: string[] = [];
  let onResult: ((event: object, ctx: object) => Promise<void> | void) | undefined;
  const mode = createUiDesignMode(cwd, async (path) => {
    opened.push(path);
  });
  mode.setEnabled(true);
  mode.extension.factory({
    on(event: string, handler: (event: object, ctx: object) => Promise<void> | void) {
      if (event === "tool_result") onResult = handler;
    },
  } as never);
  await onResult?.(
    {
      toolName: "write",
      isError: false,
      input: { path: "designs/hello.html" },
      toolCallId: "1",
    },
    {},
  );
  assert.deepEqual(opened, ["designs/hello.html"]);
});

test("the design constraint is a prompt section, not a user message", () => {
  const sections: Record<string, string> = {};
  applyUiDesignConstraint(sections, true);
  assert.match(sections.ui_design ?? "", /designs\//);
  assert.match(sections.ui_design ?? "", /标注/);
  assert.match(sections.ui_design ?? "", /文字方案/);
  assert.equal(sections.ui_design, UI_DESIGN_CONSTRAINT);
  applyUiDesignConstraint(sections, false);
  assert.equal("ui_design" in sections, false);
});

test("a user turn gets a hidden order only while the mode is on", () => {
  const message = uiDesignStartMessage(true, "user");
  assert.equal(message?.display, false);
  assert.match(message?.content ?? "", /designs\//);
  assert.match(message?.content ?? "", /没有 ui_design 段就忽略/);
  assert.equal(uiDesignStartMessage(false, "user"), undefined);
  assert.equal(uiDesignStartMessage(true, "custom"), undefined);
});

test("a prose ending continues once, a tool turn or a saved html does not", () => {
  const prose = {
    enabled: true,
    htmlWritten: false,
    nudges: 0,
    outcome: "completed",
    hasToolCall: false,
    toolResultCount: 0,
  };
  assert.equal(uiDesignShouldContinue(prose), true);
  assert.equal(uiDesignShouldContinue({ ...prose, nudges: 1 }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, enabled: false }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, htmlWritten: true }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, outcome: "aborted" }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, outcome: "error" }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, hasToolCall: true }), false);
  assert.equal(uiDesignShouldContinue({ ...prose, toolResultCount: 1 }), false);
});

test("ending without html continues once, then a later write does not", async () => {
  const opened: string[] = [];
  const handlers = new Map<string, (event: Record<string, unknown>, ctx?: object) => unknown>();
  const mode = createUiDesignMode(cwd, async (path) => {
    opened.push(path);
  });
  mode.setEnabled(true);
  mode.extension.factory({
    on(event: string, handler: (event: Record<string, unknown>, ctx?: object) => unknown) {
      handlers.set(event, handler);
    },
  } as never);
  const sections: Record<string, string> = {};
  const started = await handlers.get("before_agent_start")?.({
    messageType: "user",
    systemPromptOptions: { sections },
  });
  assert.equal(sections.ui_design, UI_DESIGN_CONSTRAINT);
  assert.equal(
    (started as { message?: { display?: boolean } } | undefined)?.message?.display,
    false,
  );

  const textEnd = {
    outcome: "completed",
    message: { role: "assistant", content: [{ type: "text", text: "方案 A" }] },
    toolResults: [],
    entries: [],
  };
  const first = (await handlers.get("turn_end")?.(textEnd)) as {
    continue?: boolean;
    entries?: Array<{ type?: string; display?: boolean; content?: string }>;
  };
  assert.equal(first.continue, true);
  assert.equal(first.entries?.[0]?.type, "custom_message");
  assert.equal(first.entries?.[0]?.display, false);
  assert.equal(first.entries?.[0]?.content, UI_DESIGN_NUDGE);
  assert.equal(await handlers.get("turn_end")?.(textEnd), undefined);

  await handlers.get("before_agent_start")?.({
    messageType: "user",
    systemPromptOptions: { sections },
  });
  await handlers.get("tool_result")?.(
    {
      toolName: "write",
      isError: false,
      input: { path: "designs/channel-card.html" },
      toolCallId: "1",
    },
    {},
  );
  assert.deepEqual(opened, ["designs/channel-card.html"]);
  assert.equal(await handlers.get("turn_end")?.(textEnd), undefined);
});
