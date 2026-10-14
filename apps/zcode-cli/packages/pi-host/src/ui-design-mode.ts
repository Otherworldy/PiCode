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
  "UI 设计模式已开启。只在当前工作区的 designs/ 里写一份自包含 HTML，样式和脚本都放在这一个文件里。",
  "写完后宿主会打开标注页。不要自己调用 plannotator，也不要把 HTML 转成 Markdown 或打开 dev server。",
  "用户批注回来后，只改同一份 HTML。关掉审查页不是通过。",
  "用户关掉 UI 设计模式之前，不要改产品代码。",
].join("");

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

/** 写入成功后要打开标注的 HTML。失败、命令、嵌套调用都不打开。 */
export function uiDesignAnnotateTarget(
  enabled: boolean,
  toolName: string,
  isError: boolean,
  args: unknown,
  cwd: string,
  parentToolCallId?: string,
): string | undefined {
  if (!enabled || isError || parentToolCallId) return undefined;
  const name = toolName.trim().toLowerCase();
  if (name !== "write" && name !== "edit") return undefined;
  const path = toolPath(args);
  if (!path || !isUiDesignWritePathAllowed(path, cwd)) return undefined;
  return path;
}

export function createUiDesignMode(
  cwd: string,
  openAnnotate: (path: string, ctx: object) => Promise<void> = async () => undefined,
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
        pi.on("tool_call", (event) =>
          uiDesignToolDecision(enabled, event.toolName, event.input, cwd),
        );
        pi.on("tool_result", (event, ctx) => {
          const target = uiDesignAnnotateTarget(
            enabled,
            event.toolName,
            event.isError,
            event.input,
            cwd,
            event.parentToolCallId,
          );
          if (!target) return;
          return openAnnotate(target, ctx);
        });
        pi.on("before_agent_start", (event) => {
          const sections = event.systemPromptOptions?.sections;
          if (!sections) return;
          applyUiDesignConstraint(sections, enabled);
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
