// v4 行渲染上下文（ai-elements / ToolCallBlocks 回接所需的宿主注入面）。
// 注入模式对齐 PermissionDialog（store 耦合剥离）：展示组件不自取 store，
// theme / codePreviewSettings 在宿主（SessionPane）处取，向下走稳定 props。
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import type { Theme } from "@/useTheme.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  HookInvocationRow,
  TurnHeaderRow,
  TurnUsage,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationFileChangesState = Exclude<
  NonNullable<TurnHeaderRow["fileChanges"]>["state"],
  undefined
>;

export interface ConversationRowRenderContext {
  logEpoch?: string;
  workspacePath: string;
  /** 当前 workspace Host 的用户 Home，用于解析 Assistant 输出中的 ~/ 路径。 */
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** SessionPane 从目标 Host 读取的同一份模型选择 View。 */
  modelSelectionView?: ModelSelectionView | null;
  theme: Theme;
  /** 需保持引用稳定（MessageResponse/ToolCallBlock 的 memo 依赖）。 */
  codePreviewSettings: CodePreviewSettings;
  /** 当前 pane 绑定的父 session；subagent 右侧 tab 用它做父任务分组。 */
  sessionId?: string | null;
  /** 当前下钻树的顶层 session；详情 tab 跨嵌套层级按该 id 分组。 */
  rootSessionId?: string | null;
  /** @deprecated 旧内联下钻标记；新的子会话统一打开侧栏详情。 */
  inSubagentDrilldown?: boolean;
  /** 手机 /remote 紧凑模式：隐藏外部 App 打开下拉，只保留应用内预览。 */
  /** 当前 session 正在 compact 或 goal verify；专用状态 UI 独占进度反馈。 */
  chatLoadingBlockedByActiveWork?: boolean;
  /** 当前 session 正在等待权限确认或 AskUserQuestion 回答，隐藏底部 ChatLoading。 */
  chatLoadingBlockedByInteraction?: boolean;
  /** 常规设置：是否在对话消息流中渲染 reasoning / thought 行。 */
  messageStreamShowReasoning?: boolean;
  /** 当前 assistant 轮次的第一条 reasoning row；关闭完整思考时仍需展示。 */
  messageStreamFirstReasoningRowId?: number;
  /** 思考行缺少 durationMs 时，按相邻事件补上的时长。 */
  reasoningDurationMsByRowId?: ReadonlyMap<number, number>;
  /**
   * 当前轮的用量汇总。操作栏挂在正文行内部，拿不到 turnHeader，
   * 由 TurnGroup 通过 context 注入；客户端只读，不自己累加。
   */
  turnUsage?: TurnUsage;
  /** 当前轮的 hook 执行行，供操作栏里的 hook 详情 popover 使用。 */
  turnHookInvocations?: readonly HookInvocationRow[];
  /** 当前轮 id，hook 详情 popover 做 testid 用。 */
  turnId?: string;
  /**
   * 操作栏在正文行内部渲染，拿不到 TurnGroup 的 props，反馈回调由这里注入。
   * 与上下文里已有的 onOpenCodeViewer 等回调一致。
   */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** 常规设置：是否聚合连续的 Explore-compatible 工具。 */
  toolGroupingExploreEnabled?: boolean;
  /** 常规设置：是否聚合连续的非只读 Shell 工具。 */
  toolGroupingTerminalEnabled?: boolean;
  /** 常规设置：是否聚合连续的文件写入工具。 */
  toolGroupingChangesEnabled?: boolean;
  /**
   * Tier 1 fork 跳转：把当前 pane 切到目标会话（forkNotice → 父会话，复用 onSessionCreated
   * 原地切换）。rowId 预留 Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位、暂忽略。
   * 需保持引用稳定（rowContext 的 memo 依赖）。
   */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
  /** 行右侧分叉按钮：按总结方式建成左侧新会话。工具行的 entryId 是 toolCallId。 */
  onResumeHere?: (target: {
    entryId: string;
    role: "user" | "assistant" | "tool";
    text: string;
    summarize: boolean;
    customInstructions?: string;
  }) => void;
  /** 输入框已有草稿时返回 false，调用方不要打开回退选择。 */
  prepareRewindHere?: () => boolean;
  /**
   * 用户消息回退到此处：先由行内选总结，再裁切这条及之后的内容。
   * 不重发。成功后宿主把原文填进当前输入框。false 表示没裁切。
   * workspaceMode=rewind：先撤销锤点及之后所有 turn 的文件改动再裁切（同一条命令内完成）。
   */
  onRewindHere?: (target: {
    rowId: number;
    entityId: string;
    text: string;
    attachments?: readonly AttachmentRef[];
    summarize: boolean;
    customInstructions?: string;
    workspaceMode?: "preserve" | "rewind";
  }) => Promise<boolean | void> | boolean | void;
  /** Assistant Preview Cards：Website 卡片预览入口，由 app shell 注入 side pane 行为。 */
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  /** Assistant Preview Cards：Markdown/文件卡片预览入口，由 app shell 注入 code viewer 行为。 */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop 完成态 PPTX：由 shell 原子创建多个右侧 Preview Tab。 */
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  /** 当前 renderer 观察到 running → completedSuccess 后，锁定到具体 turn。 */
  assistantPreviewPptxAutoOpenTarget?: { turnId: string; key: string } | null;
  /** Assistant markdown 本地文件链接入口：由 shell 统一 stat 后分流到预览或文件树。 */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  /**
   * 取消一项后台工作（`cancelBackgroundWork{workId}`），由宿主绑定 dispatchCommand + sessionId。
   */
  onCancelBackgroundWork?: (workId: string) => void;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  previewFileRewind?: (
    target: ConversationRowTarget,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  applyFileRewind?: (target: ConversationRowTarget) => Promise<CommandAck>;
  /** 已发送 image/video 预览；由 pane 绑定的 workspace transport 注入。 */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  readAttachmentRange?: (
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ) => ReturnType<ConversationTransport["attachmentReadRange"]>;
}

export interface ConversationFileChangesRequestOptions {
  /**
   * 运行中 turn 的结果仍会随 projection revision 增长，只能复用进行中的请求；
   * 终态 turn 才允许在虚拟行复挂载后继续复用成功结果。
   */
  cachePolicy: "in-flight" | "terminal";
  /** rewind 会在同一 logEpoch 内切换 active/reverted，终态缓存必须按该语义状态隔离。 */
  fileChangesState?: ConversationFileChangesState;
}

export type ConversationReasoningVisibility = Pick<
  ConversationRowRenderContext,
  "messageStreamShowReasoning" | "messageStreamFirstReasoningRowId"
>;

export function isConversationReasoningRowVisible(
  rowId: number,
  visibility: ConversationReasoningVisibility,
): boolean {
  return (
    visibility.messageStreamShowReasoning === true ||
    visibility.messageStreamFirstReasoningRowId === rowId
  );
}
