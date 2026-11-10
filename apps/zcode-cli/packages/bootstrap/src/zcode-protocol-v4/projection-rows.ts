// SessionEvent payload → ConversationRow 的构造纯函数。
// row 自包含原则：这里产出的每一行都必须不依赖其它行即可渲染。
import type {
  CompactTimelineStatus,
  CompactTrigger,
  GoalStatus,
  SyntheticUserMessageSource,
  ToolResultPayload,
  TurnResultType,
  TurnStartedPayload,
} from "@zcode/contracts";
import type {
  ConversationRow,
  GoalState,
  TimelineMarkerPayload,
  ToolOutput,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

interface RowBaseInput {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
}

// inputSource → turnHeader.origin。
function mapTurnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): TurnHeaderRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    default:
      return "userInput";
  }
}

// inputSource → userInput.origin。
function mapUserInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): UserInputRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    default:
      return "realUser";
  }
}

export function buildTurnHeaderRow(base: RowBaseInput, payload: TurnStartedPayload): TurnHeaderRow {
  return {
    ...base,
    kind: "turnHeader",
    origin: mapTurnHeaderOrigin(payload.inputSource),
    executionKind: payload.executionKind ?? "agent",
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    state: "running",
    startedAt: base.createdAt,
  };
}

export function buildUserInputRow(base: RowBaseInput, payload: TurnStartedPayload): UserInputRow {
  // 附件渲染：TurnStarted 携带的展示元信息 → row.attachments。
  // ref 是内容引用占位（本地路径/artifact URI）；无稳定引用时以行内序号占位，
  // 展示层只用 fileName/mime/bytes，不据 ref 取内容（attachment/get query 属后续）。
  const attachments =
    payload.intent?.attachmentRefs ??
    payload.attachments?.map((meta, index) => ({
      ref: meta.ref ?? `turn-attachment/${base.rowId}/${index}`,
      fileName: meta.fileName,
      mime: meta.mime,
      bytes: meta.bytes,
    }));
  const sourceCommandId = payload.intent?.sourceCommandId ?? payload.inputId;
  const rootSourceCommandId = payload.intent?.provenance?.sourceCommandId ?? sourceCommandId;
  return {
    ...base,
    kind: "userInput",
    text: payload.input,
    origin: mapUserInputOrigin(payload.inputSource),
    ...(sourceCommandId ? { sourceCommandId } : {}),
    ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapTurnResultToHeaderState(
  resultType: TurnResultType,
): Exclude<TurnHeaderRow["state"], "running"> {
  switch (resultType) {
    case "success":
      return "completedSuccess";
    case "cancelled":
      return "completedInterrupted";
    default:
      return "failed";
  }
}

// CompactTimelineStatus → compact marker.status。
// 语义映射：retrying 仍是运行中；skipped = 无事发生（noop）；interrupted = 被 stop（cancelled）。
export function mapCompactMarkerStatus(
  status: CompactTimelineStatus,
): Extract<TimelineMarkerPayload, { type: "compact" }>["status"] {
  switch (status) {
    case "started":
    case "retrying":
      return "running";
    case "completed":
      return "success";
    case "skipped":
      return "noop";
    case "interrupted":
      return "cancelled";
    default:
      return "failed";
  }
}

// CompactTrigger → marker.origin：manual 之外（auto/partial/reactive/session_memory）
// 一律归 auto —— UI 只区分「用户点的」与「系统触发的」。
export function mapCompactMarkerOrigin(
  trigger: CompactTrigger,
): Extract<TimelineMarkerPayload, { type: "compact" }>["origin"] {
  return trigger === "manual" ? "manual" : "auto";
}

// 旧 GoalStatus → v4 GoalState.status。
// budget_limited 归 paused：预算耗尽与被 stop 一样等待用户显式 resume；
// complete 归 verified：旧词表没有 verifying/notSatisfied 细分，终态语义等价。
export function mapGoalStatus(status: GoalStatus): GoalState["status"] {
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "verified";
    default:
      return "paused";
  }
}

// 终态截断全档统一：head+tail 各 32K，超出部分以 truncated.ref 按需拉取。
// 阶段 ref 先用 toolCallId 占位（artifact 存取属传输外壳期）。
function capUtf8Text(text: string): { text: string; totalBytes: number; truncated: boolean } {
  const headBytes = PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes;
  const tailBytes = PROTOCOL_V4_LIMITS.toolOutputFinalTailBytes;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) return { text, totalBytes, truncated: false };
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return { text: `${head}\n…\n${tail}`, totalBytes, truncated: true };
}

export function buildToolOutput(result: ToolResultPayload, toolCallId: string): ToolOutput {
  const text = result.content;
  // 模型可见文本只保留图片占位符，若 V4 output 不独立携带 display，
  // 实时投影和冷恢复都会丢失 CUA 截图。Node REPL 图片仍走 ToolCallRow.display 专用通道。
  const display = result.display?.kind === "node_repl_images" ? undefined : result.display;
  const capped = capUtf8Text(text);
  if (!capped.truncated) return { text, ...(display ? { display } : {}) };
  return {
    text: capped.text,
    ...(display ? { display } : {}),
    truncated: { totalBytes: capped.totalBytes, ref: `tool-output/${toolCallId}` },
  };
}

/**
 * 尾窗保底：最后一轮的 `turnHeader` 与首条 `userInput` 必须随快照下发。
 *
 * `turnHeader` 落在每轮起点，长轮次必然被 60 行尾窗切掉；客户端判断「本轮在跑」读的
 * 是它，裁掉之后运行行整行消失（见 docs/specs/conversation-tail-window-turn-header.md）。
 * 这里只向上补到这两个锚点：更早的历史仍走 rows/range，窗口不做任意扩张。
 */
export function includeLeadingTurnAnchors(
  rows: readonly ConversationRow[],
  tail: readonly ConversationRow[],
): ConversationRow[] {
  if (tail.length === 0) return [...tail];
  const turnId = tail[tail.length - 1]!.turnId;
  let anchorIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.turnId !== turnId) continue;
    if (row.kind === "turnHeader") {
      anchorIndex = index;
      break;
    }
    // 还没遇到 header 就先遇到的 userInput 不是首条可见输入：
    // 冷快照可能从轮中间截断，header 更靠前，继续往前找。
  }
  if (anchorIndex < 0) return [...tail];
  const firstTailRowId = tail[0]!.rowId;
  const anchors = rows
    .slice(anchorIndex)
    .filter(
      (row) =>
        row.rowId < firstTailRowId &&
        row.turnId === turnId &&
        (row.kind === "turnHeader" || row.kind === "userInput"),
    );
  return anchors.length === 0 ? [...tail] : [...anchors, ...tail];
}

/** 下发尾窗的唯一定义：最后 N 行，外加最后一轮的行首锚点。 */
export function wireTailRows(
  rows: readonly ConversationRow[],
  limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
): ConversationRow[] {
  return includeLeadingTurnAnchors(rows, rows.length <= limit ? rows : rows.slice(-limit));
}

/**
 * 下发到页面的工具行只留 head+tail。宿主投影仍保留全文，文件回滚继续读原文。
 * 长会话尾窗里若带上完整工具输出，订阅帧会超过 16MB，会话打不开。
 */
export function capRowForWire(row: ConversationRow): ConversationRow {
  if (row.kind !== "toolCall") return row;
  let next = row;
  const input = capUtf8Text(row.inputText);
  if (input.truncated) next = { ...next, inputText: input.text };
  const output = row.output;
  if (output?.text && !output.truncated) {
    const capped = capUtf8Text(output.text);
    if (capped.truncated) {
      next = {
        ...next,
        output: {
          ...output,
          text: capped.text,
          truncated: { totalBytes: capped.totalBytes, ref: `tool-output/${row.toolCallId}` },
        },
      };
    }
  }
  const error = row.error;
  if (error?.message) {
    const message = capUtf8Text(error.message);
    if (message.truncated) next = { ...next, error: { ...error, message: message.text } };
  }
  return next;
}
