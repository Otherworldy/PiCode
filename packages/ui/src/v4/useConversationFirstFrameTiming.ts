import { useLayoutEffect, useRef } from "react";
import { logger } from "@/logger.js";
import {
  markFirstFrameStart,
  takeFirstFrameDuration,
  type FirstFrameClock,
} from "@/v4/conversationOpenTiming.js";

/**
 * 首帧只量「行已经在手，React 把它画进 DOM」这一段。
 * 宿主读 jsonl / 建 Pi 会话在另一进程，不混进这个数。
 */
export function useConversationFirstFrameTiming(sessionKey: string, rowCount: number): void {
  const clockRef = useRef<FirstFrameClock>({
    sessionKey: null,
    startedAt: null,
    logged: false,
  });
  clockRef.current = markFirstFrameStart(clockRef.current, sessionKey, rowCount, performance.now());
  useLayoutEffect(() => {
    const taken = takeFirstFrameDuration(
      clockRef.current,
      sessionKey,
      rowCount,
      performance.now(),
    );
    if (!taken) return;
    clockRef.current = taken.clock;
    logger.lifecycle.info(
      `conversation open timing session=${sessionKey} firstFrameRenderMs=${String(taken.firstFrameRenderMs)} rows=${String(rowCount)}`,
      {
        event: "ui.v4.conversation.first_frame",
        module: "ui.v4.conversation_timeline",
        sessionId: sessionKey,
        rowCount,
        firstFrameRenderMs: taken.firstFrameRenderMs,
      },
    );
  }, [rowCount, sessionKey]);
}
