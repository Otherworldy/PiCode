import http from "node:http";
import { Readable } from "node:stream";

/** Fetch 规定这些状态码不能带 body。 */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * 把 Node IncomingMessage 收成 Fetch Response。
 *
 * 204/205/304 直接把响应流塞进 `new Response` 会同步抛
 * `TypeError: Response constructor: Invalid response status code 204`。
 * 抛出点在 `http.ClientRequest` 回调里，不在 Promise 执行器内，会变成
 * uncaughtException，Agent 退出，正在进行的 session/delete 只看到 stdout_closed。
 */
export function responseFromNodeMessage(message: http.IncomingMessage): Response {
  const status = message.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  const init: ResponseInit = {
    headers,
    status,
    ...(message.statusMessage ? { statusText: message.statusMessage } : {}),
  };
  if (NULL_BODY_STATUS.has(status)) {
    message.resume();
    return new Response(null, init);
  }
  return new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, init);
}
