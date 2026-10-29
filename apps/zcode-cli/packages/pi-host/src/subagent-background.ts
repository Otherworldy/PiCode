import {
  SUBAGENT_CANCELLED_TEXT,
  SUBAGENT_FAILED_PREFIX,
  type ZcodeSubagentProfile,
} from "./host-capabilities.js";
import { abortLiveSubagent } from "./live-subagents.js";

/**
 * 后台派发的唯一所有者：一个实例对应一个父会话。
 *
 * 为什么不在 `live-subagents.ts` 里加 `abortAll`：那张 `running` 表是进程内全局的，
 * 多窗口共用一个 agent 进程，按会话隔离做不到。这里的集合是父会话私有的。
 */

export type BackgroundSubagentStatus = "success" | "failed" | "cancelled";

export type BackgroundSubagentSettled = {
  agent: string;
  childSessionId: string;
  status: BackgroundSubagentStatus;
  text: string;
};

/** 与 `runZcodeSubagent` 的取消返回值同源；面板 Stop 不经过本模块，只能靠它归类。 */
const CANCELLED_TEXT = SUBAGENT_CANCELLED_TEXT;
/** 与 `runZcodeSubagent` 的失败返回值前缀同源。 */
const FAILED_PREFIX = SUBAGENT_FAILED_PREFIX;

/** 每会话同时能跑几个后台子代理。超限直接拒绝，不排队。 */
export const MAX_BACKGROUND_SUBAGENTS = 6;

/** 通知正文上限。按字符数算，避免一次大报告把父会话上下文打爆。 */
export const MAX_BACKGROUND_RESULT_CHARS = 16 * 1024;

const TRUNCATED_NOTE = "\n\n…（正文已截断）";

const STATUS_TEXT: Record<BackgroundSubagentStatus, string> = {
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

type PendingDispatch = {
  agent: string;
  /** `onStarted` 之前是空的；`abortAll` 早于它时靠 `abortRequested` 补刀。 */
  childSessionId?: string;
  abortRequested: boolean;
  settled: boolean;
};

export function truncateSubagentText(text: string): string {
  const body = text.trim();
  if (body.length <= MAX_BACKGROUND_RESULT_CHARS) return body;
  return `${body.slice(0, MAX_BACKGROUND_RESULT_CHARS)}${TRUNCATED_NOTE}`;
}

export function formatSubagentSettled(event: BackgroundSubagentSettled): string {
  const lines = [`子代理 "${event.agent}" ${STATUS_TEXT[event.status]}。`];
  if (event.childSessionId) lines.push(`childSessionId: ${event.childSessionId}`);
  const body = truncateSubagentText(event.text);
  if (body) lines.push("", body);
  return lines.join("\n");
}

/** 面板 Stop 不经过本模块，只能从返回值归类；顺序不能反，失败前缀里也含 cancelled 的可能。 */
function statusOf(text: string): BackgroundSubagentStatus {
  if (text.trim() === CANCELLED_TEXT) return "cancelled";
  if (text.trim().startsWith(FAILED_PREFIX)) return "failed";
  return "success";
}

export function createBackgroundSubagents(input: {
  /** 已绑好 cwd / 模型 / 权限的 `runZcodeSubagent`；`onStarted` 拿真实子会话 id。 */
  run: (
    profile: ZcodeSubagentProfile,
    task: string,
    onStarted: (childSessionId: string) => void,
  ) => Promise<string>;
  /** 把结算结果投回父会话。投递失败由调用方吞掉，不影响子代理结果。 */
  notify: (text: string) => void;
  maxConcurrent?: number;
}) {
  const pending = new Map<string, PendingDispatch>();
  const maxConcurrent = input.maxConcurrent ?? MAX_BACKGROUND_SUBAGENTS;
  let counter = 0;
  /** 会话已关闭。关闭后不再接新派发，也不往死会话里投结果。 */
  let closed = false;

  function settle(token: string, entry: PendingDispatch, status: BackgroundSubagentStatus, text: string) {
    // 一次派发只结算一次：手动 Stop 与自然结束走同一个 settle 路径。
    if (entry.settled) return;
    entry.settled = true;
    pending.delete(token);
    // 会话已经结束：投递只会往正在关闭的会话里塞一条消息，甚至起一轮无人收听的请求。
    if (closed) return;
    input.notify(
      formatSubagentSettled({
        agent: entry.agent,
        childSessionId: entry.childSessionId ?? "",
        status,
        text,
      }),
    );
  }

  return {
    get running(): number {
      return pending.size;
    },

    /** 返回给模型的工具结果文本：启动说明或拒绝原因，都不含子代理正文。 */
    start(profile: ZcodeSubagentProfile, task: string): string {
      const agent = profile.name.trim();
      if (closed) return "The session is closing; background dispatch is not available.";
      if (pending.size >= maxConcurrent) {
        return `Background subagent limit reached (${maxConcurrent} running). Wait for one to settle before dispatching more.`;
      }
      const token = `bg-${++counter}`;
      const entry: PendingDispatch = { agent, abortRequested: false, settled: false };
      pending.set(token, entry);
      void input
        .run(profile, task, (childSessionId) => {
          entry.childSessionId = childSessionId;
          // abortAll 早于 onStarted：真实 id 一到就补上取消。
          if (entry.abortRequested) abortLiveSubagent(childSessionId);
        })
        .then((text) => {
          const status = entry.abortRequested ? "cancelled" : statusOf(text);
          settle(token, entry, status, status === "cancelled" ? "" : text);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const status = entry.abortRequested ? "cancelled" : "failed";
          settle(token, entry, status, status === "cancelled" ? "" : message);
        });
      return `Subagent "${agent}" started in background. Its result will arrive as a message when it settles; do not poll.`;
    },

    /** 父会话关闭时调用：停止本会话派出的全部后台子代理，并关闭投递。 */
    abortAll(): void {
      closed = true;
      for (const entry of pending.values()) {
        entry.abortRequested = true;
        if (entry.childSessionId) abortLiveSubagent(entry.childSessionId);
      }
    },
  };
}

export type BackgroundSubagents = ReturnType<typeof createBackgroundSubagents>;
