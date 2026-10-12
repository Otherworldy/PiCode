export interface PiSessionShutdownTarget {
  dispose(): void;
  extensionRunner: {
    hasHandlers(eventType: string): boolean;
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
}

/**
 * AgentSession.dispose() 不发 session_shutdown。MCP 扩展只在这个事件里关掉 stdio，
 * 不发的话 node_repl / chrome-devtools-mcp 会在常驻回收之后继续挂在 app-server 上。
 */
export function shutdownPiSession(session: PiSessionShutdownTarget): Promise<void> {
  const shutdown = session.extensionRunner.hasHandlers("session_shutdown")
    ? session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
    : Promise.resolve();
  return Promise.resolve(shutdown)
    .catch(() => undefined)
    .then(() => {
      session.dispose();
    });
}
