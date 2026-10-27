import { extname, isAbsolute, relative, resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export const UI_DESIGN_STATUS_KEY = "ui-design";
export const UI_DESIGN_STATUS_TEXT = "UI 设计";

const WRITE_DENIED =
  "UI 设计模式只允许改当前工作区 designs/ 下的 .html 或 .htm。不要改产品代码，也不要使用 bash。";

export const UI_DESIGN_CONSTRAINT = [
  "UI 设计模式已开启。唯一交付是当前工作区 designs/ 下的一份自包含 HTML，样式和脚本都写在这一个文件里。",
  "不要用 Markdown、ASCII 图或文字方案代替这份 HTML，不要开 dev server，不要用 bash、powershell 或 codemode。",
  "写完立即调用 plannotator 打开它：action=annotate、target 用这份 HTML 的路径、gate=true。然后结束本轮，等用户批注。",
  "批注回来后只改同一份 HTML，改完再调 plannotator 等下一轮批注。用户关掉 UI 设计模式之前，不要改产品代码。",
].join("\n");

/** 紧挨用户消息。关掉模式后系统提示没了这段，旧消息就失效。 */
export const UI_DESIGN_TURN_ORDER =
  "系统提示里有 ui_design 段时，本轮必须用 write 或 edit 把一份自包含 HTML 写进当前工作区的 designs/，写完立即调用 plannotator 打开它并等用户批注。不要改产品代码，不要用文字方案代替。没有 ui_design 段就忽略本条。";

/** 文字收尾、或写完 HTML 却没打开审查时，续上的那一次。同样靠 ui_design 段失效。 */
export const UI_DESIGN_NUDGE =
  "系统提示里还有 ui_design 段：上一轮没有写成 designs/ 下的 HTML 并调用 plannotator 打开它，这次不算完成。不要再解释。现在就把这份自包含 HTML 写完，写完立即调用 plannotator。没有 ui_design 段就忽略本条。";

const NUDGE_LIMIT = 1;

export function uiDesignStartMessage(
  enabled: boolean,
  messageType: string,
): { customType: string; display: false; content: string } | undefined {
  if (!enabled || messageType !== "user") return undefined;
  return { customType: "ui-design", display: false, content: UI_DESIGN_TURN_ORDER };
}

/** 没写成 HTML、或写完没打开审查，就用文字收尾时，续一次。工具回合不续，避免插进工具结果中间。 */
export function uiDesignShouldContinue(input: {
  enabled: boolean;
  htmlWritten: boolean;
  reviewOpened: boolean;
  nudges: number;
  outcome: string;
  hasToolCall: boolean;
  toolResultCount: number;
}): boolean {
  if (!input.enabled || input.reviewOpened || input.nudges >= NUDGE_LIMIT) return false;
  if (input.outcome !== "completed") return false;
  if (input.hasToolCall) return false;
  // HTML 已经写好了，只差打开审查，这时不受工具回合限制。
  if (input.htmlWritten) return true;
  if (input.toolResultCount > 0) return false;
  return true;
}

export function messageHasToolCall(message: { role?: string; content?: unknown } | undefined): boolean {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
  );
}

export function applyUiDesignConstraint(
  sections: Record<string, string>,
  enabled: boolean,
): void {
  if (!enabled) {
    delete sections.ui_design;
    return;
  }
  sections.ui_design = UI_DESIGN_CONSTRAINT;
}

/** 只允许工作区 designs/ 下的 HTML。跑出工作区、换扩展名都不行。 */
export function isUiDesignWritePathAllowed(inputPath: string, cwd: string): boolean {
  if (!inputPath.trim()) return false;
  const root = resolve(cwd);
  const target = resolve(root, inputPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const [directory, ...rest] = rel.split(/[\\/]/);
  if (directory !== "designs" || rest.length === 0) return false;
  return HTML_EXTENSIONS.has(extname(target).toLowerCase());
}

export function uiDesignToolDecision(
  enabled: boolean,
  toolName: string,
  args: unknown,
  cwd: string,
): { block: true; reason: string } | undefined {
  if (!enabled) return undefined;
  const name = toolName.trim().toLowerCase();
  if (name === "plannotator" || name.endsWith("__plannotator")) return undefined;
  if (SHELL_TOOLS.has(name)) return { block: true, reason: WRITE_DENIED };
  if (!WRITE_TOOLS.has(name)) return undefined;
  const path = toolPath(args);
  if (path && isUiDesignWritePathAllowed(path, cwd)) return undefined;
  return { block: true, reason: WRITE_DENIED };
}

/** 刚写成功的是 designs/ 下的 HTML。失败、命令、嵌套调用都不算。 */
export function uiDesignHtmlSaved(
  enabled: boolean,
  toolName: string,
  isError: boolean,
  args: unknown,
  cwd: string,
  parentToolCallId?: string,
): boolean {
  if (!enabled || isError || parentToolCallId) return false;
  const name = toolName.trim().toLowerCase();
  if (name !== "write" && name !== "edit") return false;
  const path = toolPath(args);
  return !!path && isUiDesignWritePathAllowed(path, cwd);
}

/** 模型自己调 plannotator annotate 打开审查页。宿主不再替它打开。 */
export function uiDesignReviewOpened(
  enabled: boolean,
  toolName: string,
  isError: boolean,
  args: unknown,
): boolean {
  if (!enabled || isError) return false;
  const name = toolName.trim().toLowerCase();
  if (name !== "plannotator" && !name.endsWith("__plannotator")) return false;
  const action = (args as { action?: unknown } | undefined)?.action;
  return action === "annotate";
}

export function createUiDesignMode(
  cwd: string,
  onReviewOpened: () => void = () => undefined,
): {
  extension: InlineExtension;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
} {
  let enabled = false;
  return {
    extension: {
      name: "picode-ui-design",
      hidden: true,
      factory(pi) {
        // 只写系统提示时，模型会用文字方案结束，审查页不会开。
        let htmlWritten = false;
        let reviewOpened = false;
        let nudges = 0;
        pi.on("tool_call", (event) =>
          uiDesignToolDecision(enabled, event.toolName, event.input, cwd),
        );
        pi.on("tool_result", (event) => {
          if (uiDesignReviewOpened(enabled, event.toolName, event.isError, event.input)) {
            reviewOpened = true;
            onReviewOpened();
            return;
          }
          if (
            uiDesignHtmlSaved(
              enabled,
              event.toolName,
              event.isError,
              event.input,
              cwd,
              event.parentToolCallId,
            )
          ) {
            htmlWritten = true;
          }
        });
        pi.on("before_agent_start", (event) => {
          htmlWritten = false;
          reviewOpened = false;
          nudges = 0;
          const sections = event.systemPromptOptions?.sections;
          if (sections) applyUiDesignConstraint(sections, enabled);
          const message = uiDesignStartMessage(enabled, event.messageType);
          if (!message) return;
          return { message };
        });
        pi.on("turn_end", (event) => {
          const message = event.message;
          if (
            !uiDesignShouldContinue({
              enabled,
              htmlWritten,
              reviewOpened,
              nudges,
              outcome: event.outcome,
              hasToolCall: messageHasToolCall(message),
              toolResultCount: event.toolResults.length,
            })
          ) {
            return;
          }
          nudges += 1;
          return {
            continue: true,
            entries: [
              ...event.entries,
              {
                type: "custom_message" as const,
                customType: "ui-design",
                display: false,
                content: UI_DESIGN_NUDGE,
              },
            ],
          };
        });
      },
    },
    setEnabled(next) {
      enabled = next;
    },
    isEnabled: () => enabled,
  };
}

function toolPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as { path?: unknown; file_path?: unknown; filePath?: unknown };
  const path = record.path ?? record.file_path ?? record.filePath;
  return typeof path === "string" ? path : undefined;
}
