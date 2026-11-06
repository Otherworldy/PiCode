import type { PluginUiToolBinding } from "@/plugin-ui/contract.js";
import type { ReactNode } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { countPatchFileDiffs } from "@/lib/patchDiffPreview.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";
import type { OpenPlanDetailSideTabRequest } from "@/lib/workspaceSidePane.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function readUnifiedDiffField(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  return readStringField(value, ["unified_diff", "unifiedDiff", "patch", "diff"]);
}

export function normalizeSingleFilePatch(
  patch: string | undefined,
  fileLabel: string,
): string | undefined {
  if (!patch) {
    return undefined;
  }

  const trimmedPatch = patch.trim();
  if (!trimmedPatch) {
    return undefined;
  }

  if (countPatchFileDiffs(trimmedPatch) > 1) {
    // sub-agent 二次编辑同一文件时，工具层有时会把多段 diff 拼在同一个字段返回。
    // PatchDiff 只能解析单文件 patch，直接渲染会抛错并让“点击文件名查看变更”失败。
    // 这里先丢弃多文件 patch，让上层回退到 old/newText 生成的单文件 diff（或文件内容预览）。
    return undefined;
  }

  if (/^---\s+/m.test(trimmedPatch) && /^\+\+\+\s+/m.test(trimmedPatch)) {
    return trimmedPatch;
  }

  if (trimmedPatch.startsWith("@@ ")) {
    const firstHeader = trimmedPatch.match(/^@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/m);
    const deletedCount = Number(firstHeader?.[2] ?? firstHeader?.[1] ?? "1");
    const addedCount = Number(firstHeader?.[4] ?? firstHeader?.[3] ?? "1");

    // 工具返回的 unified_diff 经常只有 hunk 片段，没有文件头。
    // 对“新建文件”场景，如果继续补成 --- a/file，PatchDiff 会按普通变更解析，
    // 大整文件新增时更容易把页面拖死。这里根据首个 hunk 判断是否为纯新增，补成 /dev/null 头。
    return [
      deletedCount === 0 && addedCount > 0 ? "--- /dev/null" : `--- a/${fileLabel}`,
      addedCount === 0 && deletedCount > 0 ? "+++ /dev/null" : `+++ b/${fileLabel}`,
      trimmedPatch,
    ].join("\n");
  }

  // apply_patch 原文也可能包含 @@，但它不是标准 unified diff。
  // 不能给这类内容强行补 ---/+++ 头，否则 summary 打开文件时会把畸形 patch 送进 PatchDiff。
  return trimmedPatch;
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // PiCode protocol 的 permission/request payload 按 schema 把工具参数放在 input，
  // 旧 UI 只读兼容输入字段 rawInput，Write/Edit 会退化成整段 JSON 展示而不是文件 diff。
  return "input" in raw ? raw.input : null;
}

export function readStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isPlainRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function readRawToolCallChanges(raw: unknown) {
  if (!isPlainRecord(raw)) {
    return {
      directChanges: null,
      rawInputChanges: null,
      rawOutputChanges: null,
    };
  }

  const rawInputSource = readRawToolCallInput(raw);
  const rawInput = isPlainRecord(rawInputSource) ? rawInputSource : null;
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;

  return {
    directChanges: isPlainRecord(raw.changes) ? raw.changes : null,
    rawInputChanges: rawInput && isPlainRecord(rawInput.changes) ? rawInput.changes : null,
    rawOutputChanges: rawOutput && isPlainRecord(rawOutput.changes) ? rawOutput.changes : null,
  };
}

export interface RawToolCallFileSummary {
  path: string;
  actionLabel: "Created" | "Edited" | "Deleted";
  operationKind: EditOperationKind;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  changeStat?: { added: number; removed: number };
  patch?: string | null;
}

export interface ToolCallBlockRenderContext {
  toolCallNode: TaskChatToolCallTreeNode;
  /** 分组里的子工具行补分叉按钮。toolId 是工具调用 id。缺省则不画。 */
  resumeMenuForToolId?: (toolId: string) => ReactNode;
  workspacePath: string;
  /**
   * 插件 UI：scope 是沙箱登记需要的 session 范围，onOpenSidePane 是"在侧栏打开"回调；
   * 由 PluginUiSessionProvider 在边界注入。缺省表示宿主不提供，带 ui:// 资源的工具回退普通 MCP 卡片。
   */
  pluginUi?: PluginUiToolBinding;
  /**
   * 应用主题（store 耦合剥离）：由构建 render context 的宿主
   * （ToolCallBlock / PermissionDialog 等）从上层状态传入，供
   * MessageResponse / EditInlineDiffContent 等展示组件做 light/dark 分流。
   * 缺省时展示组件按 "system" 兜底。
   */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：同上，由宿主传入并保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  isRunning: boolean;
  statusLabel: string;
  sourceLabel?: string;
  errorText?: string;
  childToolList: ReactNode;
  showIcon?: boolean;
  /** CUA Group 子项显式放大 App Icon；独立 CUA 保持默认尺寸。 */
  cuaAppIconClassName?: "size-4" | "size-5";
  kindLabelOverride?: ReactNode;
  disableSummaryContentAnimation?: boolean;
  /** Changes 子项可能在 diff 已存在后才挂载，首次数字也需要播放进入动画。 */
  animateDiffCountOnMount?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  /**
   * v4 subagent child session 的只读观察入口。Agent renderer 将摘要行改成
   * 直接打开右侧 tab 的动作；非 Agent 工具忽略。
   */
  agentSummaryAction?: {
    onActivate: () => void;
    testId?: string;
  };
  /** v4 已配对 subagentRow 投影出的 runtime 权威类型；流式 input 尚未完整时优先使用。 */
  authoritativeAgentType?: string;
  /** ExitPlanMode 计划卡片：由会话宿主绑定 parent/session scope 后打开 Side Pane。 */
  onOpenPlanDetail?: (request: Omit<OpenPlanDetailSideTabRequest, "parentSessionId">) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** 定时任务工具卡片跳转到管理页；automationId 存在时直接打开详情。 */
  onOpenAutomationsMain?: (automationId?: string) => void;
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
}

export interface EditKindSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

export type EditOperationKind = "write" | "edit" | "update" | "delete";
export type EditKindLabelId =
  | "chat.toolCall.edit.writing"
  | "chat.toolCall.edit.updating"
  | "chat.toolCall.edit.deleting"
  | "chat.toolCall.edit.editing"
  | "chat.toolCall.kind.write"
  | "chat.toolCall.kind.delete"
  | "chat.toolCall.kind.edit";
