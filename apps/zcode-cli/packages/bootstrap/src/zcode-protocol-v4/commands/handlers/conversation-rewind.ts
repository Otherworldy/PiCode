// 对话裁切 primitive 与「回退到此处」入口。
// 共同点：都以 anchor messageId 直接驱动 core 的 rewind，不伪造 /rewind slash turn。
import {
  RewindStrategy,
  traceContextToLogContext,
  type MessageId,
  type TurnId,
} from "@zcode/contracts";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "../executor.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import type { ConversationEditTarget } from "../../product-projection.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";

export const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";

/**
 * rewind 截断（直驱 core）：edit/retry 不再伪造 `/rewind` slash turn，而是
 * 直接提交 same-session active branch cut。workspaceMode=rewind 会在文件写入全部
 * 成功后，于同一 commit gate 调用这个 primitive。
 *
 * 组合 rewind 过去在 file transaction callback 中调用 app.submitPrompt，
 * 它会把 `/rewind` 再排入 runtime command queue；当前 edit 命令等待回调，
 * 嵌套 rewind 又等待当前命令释放队列，最终 UI 永久停在编辑态。
 * 完成后 legacy 广播 session_rewound（过渡钩子，旧侧栏消费者感知；v4 投影走
 * RewindTriggered 事件自收口，不依赖本广播）。
 */
export async function submitConversationRewind(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  anchorMessageId: string,
  summary?: { summarize?: boolean; customInstructions?: string },
): Promise<void> {
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: anchorMessageId as MessageId,
    traceContext: record.traceContext,
    ...(summary?.summarize
      ? {
          summarize: true,
          ...(summary.customInstructions ? { customInstructions: summary.customInstructions } : {}),
        }
      : {}),
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    throw new Error(`conversation rewind unavailable for ${anchorMessageId}: ${result.strategy}`);
  }
  await host.afterLegacyStateMutation?.(record, "session_rewound");
}

/**
 * 回退到此处：裁切锚点及之后的内容，不重发、不入输入队列。
 * workspaceMode=rewind 时先把锚点及之后所有 turn 的文件改动撤销，再裁切。
 *
 * 两步必须在同一条命令里完成：拆成两条 CAS 命令时，文件撤销会 bump revision，
 * 随后的裁切拿着旧 revision 被判 stale，回退必然失败，而文件已经撤销、对话还在。
 */
export async function restoreUserQueryToInput(input: {
  editTarget: ConversationEditTarget;
  envelope: CommandEnvelope;
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  summary?: { summarize?: boolean; customInstructions?: string };
  workspaceMode: "preserve" | "rewind";
}): Promise<CommandResult> {
  const { editTarget, envelope, host, record, summary, workspaceMode } = input;
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  if (record.activeAbortController) {
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 editUserQuery restore preempts active turn",
      goalPausedMutationReason: "edit_user_query_goal_paused",
    });
  }
  let rewound = false;
  try {
    if (workspaceMode === "rewind") {
      const blocked = await rewindFilesFirst(host, record, envelope, editTarget, async () => {
        // 截断发生在这次调用内部：抛错时赋值还没执行，必须先记上才能画回原对话。
        rewound = true;
        await submitConversationRewind(host, record, editTarget.transcriptMessageId, summary);
      });
      if (blocked) {
        // 文件已按 journal 补偿写回；裁切若已在 commit 里发生，把 jsonl 也画回去。
        if (rewound) await record.app.restoreRewoundConversation?.();
        return blocked;
      }
    } else {
      rewound = true;
      await submitConversationRewind(host, record, editTarget.transcriptMessageId, summary);
    }
  } catch (error) {
    if (rewound) await record.app.restoreRewoundConversation?.();
    throw error;
  }
  host.logger?.info?.("v4 editUserQuery restored to input", {
    ...traceContextToLogContext(record.traceContext),
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: "conversation.command.edit_user_query.restored_to_input",
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode,
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * 先撤销文件，再通过 commitRewind 裁切对话。返回 undefined 表示文件撤销成功；
 * 返回结果表示 blocked，调用方直接回传（此时文件没写、对话没动）。
 */
async function rewindFilesFirst(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  commitRewind: () => Promise<void>,
): Promise<CommandResult | undefined> {
  // suffix：回退点是这条消息，被撤销的是它和它之后的全部 turn。
  // messageId 供 core 按 active chain 展开；turnId 供 Pi host 按投影窗口展开
  // （Pi 主路径的 preview/apply 是宿主实现，只认 turnId，messageId 会被丢弃）。
  const fileOptions = {
    expandSuffix: true as const,
    targetMessageId: editTarget.transcriptMessageId as MessageId,
    targetTurnId: editTarget.productTurnId as TurnId,
    traceContext: record.traceContext,
  };
  const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
  // 确认框已经让用户看过 ignored（bash）文件，这里只拦「不能安全撤销」。
  if (!preview.canApply) {
    return blockRestore(host, record, envelope, "guard.workspaceRewindUnsafeFiles", preview);
  }
  const applied = await record.app.runtime.applyWorkspaceFileRewind({
    ...fileOptions,
    commitAfterApply: commitRewind,
  });
  if (!applied.applied) {
    return blockRestore(
      host,
      record,
      envelope,
      "guard.workspaceRewindApplyConflict",
      applied.preview,
    );
  }
  return undefined;
}

async function blockRestore(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  reasonCode: string,
  preview: Awaited<ReturnType<V4SessionRecordView["app"]["runtime"]["previewWorkspaceFileRewind"]>>,
): Promise<CommandResult> {
  await host.cancelInputCommand?.(
    record.app.sessionId,
    commandAdmissionOf(envelope).queueItemId,
    reasonCode,
  );
  // blocked 走的是 accepted ACK，客户端只能从 result 读到原因；服务端必须自己留痕。
  host.logger?.warn?.("v4 restore to input blocked", {
    ...traceContextToLogContext(record.traceContext),
    event: "conversation.command.edit_user_query.restore_blocked",
    module: CONVERSATION_COMMAND_LOG_MODULE,
    reasonCode,
    sessionId: record.app.sessionId,
  });
  return {
    type: "editUserQuery",
    disposition: "blocked",
    sessionId: record.app.sessionId,
    reasonCode,
    preview,
  };
}
