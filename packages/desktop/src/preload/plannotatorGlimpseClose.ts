/**
 * 送进网页主世界执行。toString 之后不能引用本文件以外的变量。
 * 审查页没有 glimpse 时会调用 window.close。webview 里那次原生关闭只把 guest 清成空白，标签还在。
 */
export function installPlannotatorGuestClose(bridgeKey: string): void {
  const installed = "__zcodePlannotatorCloseInstalled";
  const attempt = (): "done" | "skip" | "wait" => {
    const host = window.location.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") {
      return "skip";
    }
    const marked = window as Window & { [installed]?: boolean };
    if (marked[installed]) return "done";
    const bridge = (window as unknown as Record<string, { close?: () => void } | undefined>)[
      bridgeKey
    ];
    if (!bridge?.close) return "wait";
    marked[installed] = true;
    const notify = (): void => {
      try {
        bridge.close?.();
      } catch {
        // 宿主不在时不要把审查页打崩成空白。
      }
    };
    const page = window as Window & { glimpse?: { close?: () => void } };
    if (typeof page.glimpse?.close !== "function") {
      page.glimpse = { close: notify };
    }
    window.close = () => {
      notify();
    };
    window.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { __plannotator_glimpse_close?: unknown } | null;
      if (!data || data.__plannotator_glimpse_close !== true) return;
      notify();
    });
    return "done";
  };
  if (attempt() !== "wait") return;
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      attempt();
    },
    { once: true },
  );
}
