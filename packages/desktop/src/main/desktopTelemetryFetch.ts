/**
 * Electron Net.fetch 只接受 `string | Request`（不接受 URL），而 `typeof fetch` 的入参还包含 URL。
 * 这里把 source 的入参对齐 Net，并在包装层把 URL 归一成字符串，避免调用方各自 cast。
 */
interface DesktopTelemetryFetchSource {
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

export function createDesktopTelemetryFetch(source: DesktopTelemetryFetchSource): typeof fetch {
  return (input, init) => source.fetch(input instanceof URL ? input.href : input, init);
}
